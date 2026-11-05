//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	schema "github.com/apilens/apilens/authz"
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
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestApdex checks the Apdex of summary, endpoints and endpoint latency
// against real Postgres, ClickHouse and SpiceDB as thresholds are set:
// 500 ms by default, then an app-wide threshold, then an endpoint's own,
// which wins over its app's.
func TestApdex(t *testing.T) {
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
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	other := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO apps (id, project_id, slug, name) VALUES ($1, $2, 'backoffice', 'Backoffice')`, other, seed.ProjectID); err != nil {
		t.Fatal(err)
	}
	admin, member := uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{admin, member} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, []string{"admin@example.com", "member@example.com"}[i]); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, seed.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", seed.ProjectID.String(), "org", "organization", seed.OrgID.String()),
		touch("organization", seed.OrgID.String(), "admin", "user", admin.String()),
		touch("organization", seed.OrgID.String(), "member", "user", member.String()),
	}); err != nil {
		t.Fatal(err)
	}

	// Each of storefront GET /a, storefront GET /b and backoffice GET /a
	// answers in 100, 300, 900 and 3000 ms.
	ins := pipeline.ClickHouseInserters(conn)
	now := time.Now().UTC()
	var rows []pipeline.RequestRow
	add := func(app uuid.UUID, path string) {
		for _, ms := range []float64{100, 300, 900, 3000} {
			rows = append(rows, pipeline.RequestRow{
				ProjectID: seed.ProjectID, AppID: app, Environment: "production", Timestamp: now.Add(-time.Duration(len(rows)+1) * time.Minute),
				Method: "GET", Path: path, RawPath: path, StatusCode: 200, ResponseTimeMs: ms,
			})
		}
	}
	add(seed.AppID, "/a")
	add(seed.AppID, "/b")
	add(other, "/a")
	if err := ins.Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	api.UseMiddleware(func(hctx huma.Context, next func(huma.Context)) {
		if id := hctx.Header("X-Test-User"); id != "" {
			hctx = huma.WithContext(hctx, authn.WithPrincipal(hctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: uuid.MustParse(id)}))
		}
		next(hctx)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	guard := authz.NewGuard(client, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(conn, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	do := func(method, path, user string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if user != "" {
			req.Header.Set("X-Test-User", user)
		} else {
			req.Header.Set("Authorization", "Bearer "+seed.ReadKey)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	near := func(got *float64, want float64) bool {
		return got != nil && math.Abs(*got-want) < 0.006
	}
	check := func(stage string, summary, a, b float64) {
		t.Helper()
		var s struct {
			Apdex *float64 `json:"apdex"`
		}
		if code := do(http.MethodGet, "/api/v1/traffic/summary?range=1h", "", nil, &s); code != 200 || !near(s.Apdex, summary) {
			t.Fatalf("%s: summary apdex = %d %v, want %v", stage, code, s.Apdex, summary)
		}
		var perf struct {
			Summary struct {
				Apdex *float64 `json:"apdex"`
			} `json:"summary"`
		}
		if code := do(http.MethodGet, "/api/v1/traffic/latency?range=1h", "", nil, &perf); code != 200 || !near(perf.Summary.Apdex, summary) {
			t.Fatalf("%s: traffic latency apdex = %d %v, want %v", stage, code, perf.Summary.Apdex, summary)
		}
		var eps struct {
			Endpoints []struct {
				Path  string   `json:"path"`
				Apdex *float64 `json:"apdex"`
			} `json:"endpoints"`
		}
		if code := do(http.MethodGet, "/api/v1/traffic/endpoints?range=1h", "", nil, &eps); code != 200 || len(eps.Endpoints) != 2 {
			t.Fatalf("%s: endpoints = %d %+v", stage, code, eps)
		}
		for _, e := range eps.Endpoints {
			if want := map[string]float64{"/a": a, "/b": b}[e.Path]; !near(e.Apdex, want) {
				t.Fatalf("%s: endpoint %s apdex = %v, want %v", stage, e.Path, e.Apdex, want)
			}
		}
		for path, want := range map[string]float64{"/a": a, "/b": b} {
			var l struct {
				Summary struct {
					Apdex *float64 `json:"apdex"`
				} `json:"summary"`
			}
			if code := do(http.MethodGet, "/api/v1/endpoints/GET/"+url.PathEscape(path)+"/latency?range=1h", "", nil, &l); code != 200 || !near(l.Summary.Apdex, want) {
				t.Fatalf("%s: latency %s apdex = %d %v, want %v", stage, path, code, l.Summary.Apdex, want)
			}
		}
	}

	// Default T = 500: 100, 300 satisfied, 900 tolerating, 3000 frustrated
	// everywhere: (2 + 0.5) / 4.
	check("default", 0.625, 0.625, 0.625)

	// App settings: defaults, viewers read, only project admins write.
	appPath := "/api/v1/apps/" + seed.AppID.String() + "/settings"
	var app struct {
		LatencyThresholdMs *int `json:"latency_threshold_ms"`
		ApdexThresholdMs   int  `json:"apdex_threshold_ms"`
	}
	if code := do(http.MethodGet, appPath, "", nil, &app); code != 200 || app.LatencyThresholdMs != nil || app.ApdexThresholdMs != 500 {
		t.Fatalf("app settings default = %d %+v", code, app)
	}
	if code := do(http.MethodGet, "/api/v1/apps/"+uuid.NewString()+"/settings", "", nil, nil); code != http.StatusNotFound {
		t.Fatalf("unknown app = %d, want 404", code)
	}
	set250 := map[string]any{"latency_threshold_ms": 250}
	if code := do(http.MethodPut, appPath, member.String(), set250, nil); code != http.StatusForbidden {
		t.Fatalf("member write = %d, want 403", code)
	}
	if code := do(http.MethodPut, appPath, "", set250, nil); code != http.StatusUnauthorized {
		t.Fatalf("read key write = %d, want 401", code)
	}
	if code := do(http.MethodPut, appPath, admin.String(), set250, &app); code != 200 || app.LatencyThresholdMs == nil || *app.LatencyThresholdMs != 250 {
		t.Fatalf("admin write = %d %+v", code, app)
	}

	// Storefront T = 250: 100 satisfied, 300 and 900 tolerating (<= 1000):
	// (1 + 1) / 4 = 0.5; backoffice keeps 500 ms. GET /a is both apps:
	// (2 + 2.5) / 8; summary (2 + 2 + 2.5) / 12.
	check("app threshold", 6.5/12, 4.5/8, 0.5)

	// Storefront GET /a T = 1000 overrides the app's 250: 100, 300, 900
	// satisfied, 3000 tolerating (<= 4000): 3.5 / 4. GET /b keeps 250.
	if code := do(http.MethodPut, "/api/v1/apps/"+seed.AppID.String()+"/endpoints/GET/"+url.PathEscape("/a")+"/settings", admin.String(),
		map[string]any{"latency_threshold_ms": 1000, "excluded": false}, nil); code != 200 {
		t.Fatalf("endpoint threshold = %d", code)
	}
	check("endpoint threshold", 8.0/12, 6.0/8, 0.5)

	// Clearing the app threshold puts GET /b back on 500 ms; the endpoint's
	// own threshold stays.
	if code := do(http.MethodPut, appPath, admin.String(), map[string]any{"latency_threshold_ms": nil}, &app); code != 200 || app.LatencyThresholdMs != nil || app.ApdexThresholdMs != 500 {
		t.Fatalf("clear app threshold = %d %+v", code, app)
	}
	check("cleared app threshold", 8.5/12, 6.0/8, 0.625)
}
