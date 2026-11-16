//go:build integration

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// setupPause mounts the project endpoints (audited, invalidating the keys of
// a project it pauses or resumes over Valkey, as the api role runs them) and
// the API key endpoints, with an edge-style verifier subscribed to the
// invalidation channel and a key cache TTL (keyCacheTTL) only the
// invalidation can beat.
func setupPause(t *testing.T) *keysFixture {
	t.Helper()
	f := setupOrgs(t, ratelimit.Rate{})
	logger := testutil.Logger(t)
	vcfg := testutil.Valkey(t)
	vk, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	publish := func(ctx context.Context, hash string) error {
		return cache.Publish(ctx, vk, apikeys.InvalidateChannel, hash)
	}
	svc := projects.New(f.pool).WithAudit(audit.New(f.pool)).WithKeyInvalidation(publish)
	NewProjects(svc, f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, logger).Register(f.api)
	NewAPIKeys(apikeys.NewService(f.pool, audit.New(f.pool), publish, logger), f.projectGuard(t), logger).Register(f.api)

	v := apikeys.NewVerifier(db.New(f.pool), apikeys.Options{Size: 100, TTL: keyCacheTTL, NegativeTTL: keyCacheTTL}, logger, nil)
	sub, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sub.Close)
	ctx, cancel := context.WithCancel(f.ctx)
	t.Cleanup(cancel)
	go cache.Subscribe(ctx, sub, logger, apikeys.InvalidateChannel, v.Invalidate)
	time.Sleep(200 * time.Millisecond) // let SUBSCRIBE land
	return &keysFixture{orgsFixture: f, verifier: v}
}

// Pausing a project makes the ingest edge answer 403 project_paused to its
// keys, on every ingest endpoint, without waiting for the key cache; resuming
// makes it accept them again. Only project admins (delete on the project)
// may pause or resume; both are audited and paused_at is in the project
// response.
func TestPauseAndResumeIngest(t *testing.T) {
	f := setupPause(t)
	owner := f.user(t, "pause-owner@example.com")
	member := f.user(t, "pause-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.mustCreateProject(t, owner, "acme", "Checkout", "checkout")
	key := f.mustCreateKey(t, owner, "checkout", "Install", "ingest", "read")

	sink := &recordingSink{}
	apps := catalog.NewAppResolver(db.New(f.pool), time.Minute).WithProvisioner(appsvc.NewProvisioner(f.pool, nil, appsvc.Limits{}))
	edge := ingest.New(f.verifier, apps, sink, config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}, testutil.Logger(t), nil)
	mux := http.NewServeMux()
	edge.Register(mux)
	send := func(path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", key.Key)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	request := func() *httptest.ResponseRecorder {
		ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
		return send("/v1/requests", `{"requests":[{"app_id":"checkout","timestamp":"`+ts+
			`","method":"GET","path":"/orders/{id}","status_code":200,"response_time_ms":3}]}`)
	}

	// Accepted, and the key is now in the edge's cache.
	if rec := request(); rec.Code != http.StatusOK {
		t.Fatalf("before pause: %d %s", rec.Code, rec.Body)
	}
	got := decode[Project](t, f.api.Get(ProjectsPath+"/checkout", as(owner)))
	if got.PausedAt != nil || got.PausedBy != nil {
		t.Fatalf("new project paused: %+v", got)
	}

	// Editors cannot pause.
	if resp := f.api.Post(ProjectsPath+"/checkout/pause", as(member), map[string]any{}); resp.Code != http.StatusForbidden {
		t.Fatalf("member pause: %d %s", resp.Code, resp.Body)
	}

	resp := f.api.Post(ProjectsPath+"/checkout/pause", as(owner), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("pause: %d %s", resp.Code, resp.Body)
	}
	paused := decode[Project](t, resp)
	if paused.PausedAt == nil || paused.PausedBy == nil || *paused.PausedBy != owner.String() {
		t.Fatalf("paused project = %+v", paused)
	}
	// Pausing again changes nothing.
	again := decode[Project](t, f.api.Post(ProjectsPath+"/checkout/pause", as(owner), map[string]any{}))
	if again.PausedAt == nil || !again.PausedAt.Equal(*paused.PausedAt) {
		t.Fatalf("second pause moved paused_at: %v -> %v", paused.PausedAt, again.PausedAt)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.paused'`); n != 1 {
		t.Fatalf("project.paused events = %d, want 1", n)
	}

	// Every ingest endpoint refuses the key once the invalidation arrives,
	// well within the one-minute key cache.
	deadline := time.Now().Add(5 * time.Second)
	for {
		rec := request()
		if rec.Code == http.StatusForbidden {
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error != ingest.CodeProjectPaused {
				t.Fatalf("paused: body %s, want %s", rec.Body, ingest.CodeProjectPaused)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still accepted after pause: %d %s", rec.Code, rec.Body)
		}
		time.Sleep(25 * time.Millisecond)
	}
	for path, body := range map[string]string{
		"/v1/logs":      `{"logs":[{"app_id":"checkout","timestamp":"2026-10-22T11:00:00Z","message":"m"}]}`,
		"/v1/deploys":   `{"deploys":[{"release":"v1"}]}`,
		"/v1/heartbeat": `{"app_id":"checkout"}`,
	} {
		if rec := send(path, body); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), ingest.CodeProjectPaused) {
			t.Errorf("%s while paused: %d %s", path, rec.Code, rec.Body)
		}
	}
	stored := len(sink.requests)
	if p := decode[Project](t, f.api.Get(ProjectsPath+"/checkout", as(owner))); p.PausedAt == nil || !p.PausedAt.Equal(*paused.PausedAt) {
		t.Fatalf("get while paused = %+v", p)
	}

	// Editors cannot resume either; the owner can.
	if resp := f.api.Post(ProjectsPath+"/checkout/resume", as(member), map[string]any{}); resp.Code != http.StatusForbidden {
		t.Fatalf("member resume: %d %s", resp.Code, resp.Body)
	}
	resp = f.api.Post(ProjectsPath+"/checkout/resume", as(owner), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("resume: %d %s", resp.Code, resp.Body)
	}
	if p := decode[Project](t, resp); p.PausedAt != nil || p.PausedBy != nil {
		t.Fatalf("resumed project = %+v", p)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.resumed'`); n != 1 {
		t.Fatalf("project.resumed events = %d, want 1", n)
	}

	deadline = time.Now().Add(5 * time.Second)
	for {
		rec := request()
		if rec.Code == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still refused after resume: %d %s", rec.Code, rec.Body)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if len(sink.requests) != stored+1 {
		t.Fatalf("stored %d requests after resume, want %d", len(sink.requests), stored+1)
	}
}
