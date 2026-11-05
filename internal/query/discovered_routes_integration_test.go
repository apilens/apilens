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

	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEndpointsListDiscoveredRoutes stores an app's metadata routes next to
// traffic on one of them and checks the endpoints list shows the routes
// without traffic as zero rows marked discovered_only, scoped to the
// environment and leaving out excluded endpoints.
func TestEndpointsListDiscoveredRoutes(t *testing.T) {
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

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	meta := func(app, project any, env, routes string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO app_metadata (app_id, environment, project_id, routes) VALUES ($1, $2, $3, $4::jsonb)`,
			app, env, project, routes); err != nil {
			t.Fatal(err)
		}
	}
	meta(seed.AppID, seed.ProjectID, "production",
		`[{"method":"GET","path":"/orders/{id}"},{"method":"POST","path":"/orders"},{"method":"GET","path":"/health"}]`)
	meta(seed.AppID, seed.ProjectID, "staging", `[{"method":"DELETE","path":"/orders/{id}"}]`)
	meta(other.AppID, other.ProjectID, "production", `[{"method":"GET","path":"/secret"}]`)
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_settings (app_id, method, path, excluded) VALUES ($1, 'GET', '/health', true)`, seed.AppID); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	var rows []pipeline.RequestRow
	for i, c := range []uint16{200, 200, 500} {
		rows = append(rows, pipeline.RequestRow{
			ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production", Timestamp: now.Add(-time.Duration(i+1) * time.Minute),
			Method: "GET", Path: "/orders/{id}", RawPath: "/orders/1", StatusCode: c, ResponseTimeMs: 10,
		})
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	type ep struct {
		Method         string   `json:"method"`
		Path           string   `json:"path"`
		Requests       uint64   `json:"requests"`
		ServerErrors   uint64   `json:"server_errors"`
		ErrorRate      float64  `json:"error_rate"`
		P95Ms          float64  `json:"p95_ms"`
		Apdex          *float64 `json:"apdex"`
		DiscoveredOnly bool     `json:"discovered_only"`
	}
	list := func(query string) []ep {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/traffic/endpoints?range=1h"+query, nil)
		req.Header.Set("Authorization", "Bearer "+seed.ReadKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out struct {
			Endpoints []ep `json:"endpoints"`
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("endpoints%s = %d", query, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.Endpoints
	}

	got := list("&env=production")
	if len(got) != 2 {
		t.Fatalf("production endpoints = %+v, want /orders/{id} with traffic and POST /orders", got)
	}
	if e := got[0]; e.Path != "/orders/{id}" || e.Requests != 3 || e.ServerErrors != 1 || e.DiscoveredOnly {
		t.Errorf("traffic endpoint = %+v", e)
	}
	if e := got[1]; e.Method != "POST" || e.Path != "/orders" || !e.DiscoveredOnly ||
		e.Requests != 0 || e.ServerErrors != 0 || e.ErrorRate != 0 || e.P95Ms != 0 || e.Apdex != nil {
		t.Errorf("zero-traffic endpoint = %+v, want zeros and discovered_only", e)
	}

	// All environments add the staging route; the other project's route and
	// the excluded /health never show.
	got = list("")
	paths := map[string]bool{}
	for _, e := range got {
		paths[e.Method+" "+e.Path] = e.DiscoveredOnly
	}
	if len(got) != 3 || !paths["DELETE /orders/{id}"] || !paths["POST /orders"] || paths["GET /orders/{id}"] {
		t.Fatalf("all-environment endpoints = %+v", got)
	}

	// The limit counts discovered routes too.
	if got := list("&limit=1"); len(got) != 1 || got[0].DiscoveredOnly {
		t.Fatalf("limit=1 = %+v", got)
	}
}
