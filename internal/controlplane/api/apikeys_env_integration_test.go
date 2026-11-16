//go:build integration

package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/config"
)

// A key pinned to some environments (#774): create and update-api-key-access
// accept only environments the project has, the list shows the pin, and the
// edge stores the records of a mixed batch whose environment is allowed and
// counts the others as rejected (environment_not_allowed).
func TestAPIKeyEnvironmentPinning(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "env-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Checkout", "checkout", "production", "staging")

	// An environment the project does not have is refused.
	if resp := f.createKey(owner, "checkout", map[string]any{"name": "Bad", "scopes": []string{"ingest"}, "environments": []string{"qa"}}); resp.Code != http.StatusBadRequest && resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown environment: %d %s", resp.Code, resp.Body)
	}

	resp := f.createKey(owner, "checkout", map[string]any{"name": "Staging", "scopes": []string{"ingest"}, "environments": []string{"staging"}})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create pinned key: %d %s", resp.Code, resp.Body)
	}
	key := decode[CreatedAPIKey](t, resp)
	if !slices.Equal(key.Environments, []string{"staging"}) {
		t.Fatalf("created environments = %v", key.Environments)
	}
	unpinned := f.mustCreateKey(t, owner, "checkout", "Any", "ingest")
	if unpinned.Environments != nil || !strings.Contains(f.api.Get(ProjectsPath+"/checkout/api-keys", as(owner)).Body.String(), `"environments":null`) {
		t.Fatalf("unpinned key environments = %v", unpinned.Environments)
	}

	// The edge, with its key cache.
	sink := &recordingSink{}
	apps := catalog.NewAppResolver(db.New(f.pool), time.Minute).WithProvisioner(appsvc.NewProvisioner(f.pool, nil, appsvc.Limits{}))
	reg := prometheus.NewRegistry()
	edge := ingest.New(f.verifier, apps, sink, config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000},
		slog.New(slog.NewTextHandler(io.Discard, nil)), reg)
	mux := http.NewServeMux()
	edge.Register(mux)
	send := func(raw string, envs ...string) *httptest.ResponseRecorder {
		ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
		recs := make([]string, len(envs))
		for i, env := range envs {
			recs[i] = `{"app_id":"checkout","environment":"` + env + `","timestamp":"` + ts +
				`","method":"GET","path":"/orders/` + env + `","status_code":200}`
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(`{"requests":[`+strings.Join(recs, ",")+`]}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", raw)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	// Key cache carries the environment scope.
	p, err := f.verifier.Verify(f.ctx, key.Key)
	if err != nil || !slices.Equal(p.Environments, []string{"staging"}) {
		t.Fatalf("verified principal environments = %v, %v", p.Environments, err)
	}

	// Mixed batch: the staging records are stored, production is rejected.
	rec := send(key.Key, "staging", "production", "staging", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("mixed batch: %d %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"accepted":2`) || !strings.Contains(body, `"error":"environment_not_allowed"`) ||
		!strings.Contains(body, `"environment":"production"`) || !strings.Contains(body, `"records":2`) {
		t.Fatalf("mixed batch body = %s", body)
	}
	if len(sink.requests) != 2 || sink.requests[0].Environment != "staging" || sink.requests[1].Environment != "staging" {
		t.Fatalf("stored rows = %+v", sink.requests)
	}
	if n := counterValue(t, reg, "apilens_ingest_app_rejected_records_total", "reason", "environment_not_allowed"); n != 2 {
		t.Fatalf("rejected counter = %v, want 2", n)
	}

	// Only disallowed records: the call fails with the reason.
	if rec := send(key.Key, "production"); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"error":"environment_not_allowed"`) {
		t.Fatalf("all rejected: %d %s", rec.Code, rec.Body)
	}
	// An unpinned key sends for every environment.
	if rec := send(unpinned.Key, "production", "staging"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":2`) {
		t.Fatalf("unpinned key: %d %s", rec.Code, rec.Body)
	}

	access := ProjectsPath + "/checkout/api-keys/" + key.ID + "/access"
	// Omitting environments keeps the pin.
	resp = f.api.Put(access, as(owner), map[string]any{"can_create_apps": true, "app_ids": nil})
	if resp.Code != http.StatusOK || !slices.Equal(decode[APIKey](t, resp).Environments, []string{"staging"}) {
		t.Fatalf("update without environments: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Put(access, as(owner), map[string]any{"can_create_apps": true, "app_ids": nil, "environments": []string{"qa"}}); resp.Code != http.StatusBadRequest && resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update with unknown environment: %d %s", resp.Code, resp.Body)
	}
	resp = f.api.Put(access, as(owner), map[string]any{"can_create_apps": true, "app_ids": nil, "environments": []string{"production"}})
	if resp.Code != http.StatusOK || !slices.Equal(decode[APIKey](t, resp).Environments, []string{"production"}) {
		t.Fatalf("repin: %d %s", resp.Code, resp.Body)
	}
	// The cache was invalidated: production is now allowed, staging is not.
	waitFor(t, func() bool { return send(key.Key, "production").Code == http.StatusOK })
	if rec := send(key.Key, "staging"); rec.Code != http.StatusForbidden {
		t.Fatalf("staging after repin: %d %s", rec.Code, rec.Body)
	}
	// null clears the pin.
	resp = f.api.Put(access, as(owner), map[string]any{"can_create_apps": true, "app_ids": nil, "environments": nil})
	if resp.Code != http.StatusOK || decode[APIKey](t, resp).Environments != nil {
		t.Fatalf("clear pin: %d %s", resp.Code, resp.Body)
	}
	waitFor(t, func() bool { return send(key.Key, "staging").Code == http.StatusOK })
}

// counterValue returns the value of the counter vector name with
// label=value in reg.
func counterValue(t *testing.T, reg *prometheus.Registry, name, label, value string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range families {
		if mf.GetName() != name {
			continue
		}
		for _, m := range mf.GetMetric() {
			for _, lp := range m.GetLabel() {
				if lp.GetName() == label && lp.GetValue() == value {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	t.Fatalf("no %s{%s=%q}", name, label, value)
	return 0
}

// waitFor polls cond for up to 5 seconds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 5s")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
