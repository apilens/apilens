//go:build integration

package query_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// projectChecker grants view on the listed project ids to every user.
type projectChecker map[string]bool

func (c projectChecker) Check(_ context.Context, _ authz.Object, perm authz.Permission, res authz.Resource) (bool, error) {
	return perm == authz.ProjectView && res.Type == authz.TypeProject && c[res.ID], nil
}

// testUserHeader stands in for a verified session: its value is the user id.
const testUserHeader = "X-Test-User"

// TestIngestStatus covers GET /api/v1/projects/{project}/ingest-status with a
// read key and a session: empty and populated projects, the 1h count, tenant
// isolation and the latency budget on an empty table.
func TestIngestStatus(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	live, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "fresh", AppSlug: "api", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	authn.AddSecurityScheme(api)
	// A request carrying testUserHeader is a signed-in user, as
	// authn.Middleware would leave it.
	api.UseMiddleware(func(hc huma.Context, next func(huma.Context)) {
		if id, err := uuid.Parse(hc.Header(testUserHeader)); err == nil {
			hc = huma.WithContext(hc, authn.WithPrincipal(hc.Context(), authn.Principal{Kind: authn.KindUser, UserID: id, SessionID: uuid.New(), AMR: []string{"otp"}}))
		}
		next(hc)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	api.UseMiddleware(query.AuthMiddleware(api, verifier))
	checker := projectChecker{live.ProjectID.String(): true, empty.ProjectID.String(): true}
	guard := authz.NewGuard(checker, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	query.Register(api, query.NewService(conn, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	type status struct {
		Received bool       `json:"received"`
		FirstAt  *time.Time `json:"first_at"`
		LastAt   *time.Time `json:"last_at"`
		Count1h  uint64     `json:"count_1h"`
	}
	get := func(header, value, slug string) (int, status) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/projects/"+slug+"/ingest-status", nil)
		if header != "" {
			req.Header.Set(header, value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out status
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode, out
	}
	bearer := func(key string) (string, string) { return "Authorization", "Bearer " + key }

	// Nothing stored yet: the empty answer, well within the latency budget.
	h, v := bearer(empty.ReadKey)
	if code, s := get(h, v, "fresh"); code != http.StatusOK || s.Received || s.FirstAt != nil || s.LastAt != nil || s.Count1h != 0 {
		t.Fatalf("empty project = %d %+v", code, s)
	}
	best := time.Hour
	for range 5 {
		start := time.Now()
		if code, _ := get(h, v, "fresh"); code != http.StatusOK {
			t.Fatalf("empty project = %d", code)
		}
		best = min(best, time.Since(start))
	}
	if best > 100*time.Millisecond {
		t.Errorf("ingest status on an empty table took %s, want < 100ms", best)
	}

	// Traffic for live (one old, two recent) and for the other tenant.
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := func(r bootstrap.Result, at time.Time) pipeline.RequestRow {
		return pipeline.RequestRow{ProjectID: r.ProjectID, AppID: r.AppID, Environment: "production", Timestamp: at, Method: "GET", Path: "/", RawPath: "/", StatusCode: 200}
	}
	oldest, newest := now.Add(-3*time.Hour), now.Add(-time.Minute)
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, []pipeline.RequestRow{
		row(live, oldest), row(live, now.Add(-10*time.Minute)), row(live, newest),
		row(other, now.Add(-time.Minute)), row(other, now.Add(-time.Minute)),
	}); err != nil {
		t.Fatal(err)
	}

	h, v = bearer(live.ReadKey)
	code, s := get(h, v, "shop")
	if code != http.StatusOK || !s.Received || s.Count1h != 2 || s.FirstAt == nil || !s.FirstAt.Equal(oldest) || s.LastAt == nil || !s.LastAt.Equal(newest) {
		t.Fatalf("live project = %d %+v (want first %s, last %s, 2 in 1h)", code, s, oldest, newest)
	}

	// A session that can view the project reads the same status.
	user := uuid.NewString()
	if code, got := get(testUserHeader, user, "shop"); code != http.StatusOK || got.Count1h != 2 || !got.Received {
		t.Fatalf("session = %d %+v", code, got)
	}
	// The other tenant's traffic never shows up in fresh.
	if code, got := get(testUserHeader, user, "fresh"); code != http.StatusOK || got.Received {
		t.Fatalf("session fresh = %d %+v", code, got)
	}

	for _, tc := range []struct {
		name          string
		header, value string
		slug          string
		want          int
	}{
		{"session without view", testUserHeader, user, "bank", http.StatusNotFound},
		{"unknown project", testUserHeader, user, "nope", http.StatusNotFound},
		{"read key of another project", "Authorization", "Bearer " + live.ReadKey, "bank", http.StatusNotFound},
		{"ingest key", "Authorization", "Bearer " + live.APIKey, "shop", http.StatusForbidden},
		{"no credentials", "", "", "shop", http.StatusUnauthorized},
	} {
		if code, _ := get(tc.header, tc.value, tc.slug); code != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, code, tc.want)
		}
	}
}
