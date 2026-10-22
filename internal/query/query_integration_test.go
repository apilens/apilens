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

	"github.com/google/uuid"
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

// TestDashboardQueriesAreTenantScoped writes traffic for two projects and
// checks every endpoint returns only the read key's project.
func TestDashboardQueriesAreTenantScoped(t *testing.T) {
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

	mine, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	ins := pipeline.ClickHouseInserters(conn)
	now := time.Now().UTC()
	trace := "4bf92f3577b34da6a3ce929d0e0e4736"
	reqs := func(project, app uuid.UUID, path string, codes ...uint16) []pipeline.RequestRow {
		var rows []pipeline.RequestRow
		for i, c := range codes {
			rows = append(rows, pipeline.RequestRow{
				ProjectID: project, AppID: app, Environment: "production", Timestamp: now.Add(-time.Duration(i+1) * time.Minute),
				Method: "GET", Path: path, RawPath: path, StatusCode: c, ResponseTimeMs: float64(10 * (i + 1)), ConsumerID: "alice", TraceID: trace,
			})
		}
		return rows
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(ins.Requests(ctx, append(reqs(mine.ProjectID, mine.AppID, "/orders/{id}", 200, 200, 404, 500), reqs(theirs.ProjectID, theirs.AppID, "/secret", 200, 500, 500)...)))
	must(ins.Spans(ctx, []pipeline.SpanRow{
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute), TraceID: trace, SpanID: "00f067aa0ba902b7", Name: "GET /orders/{id}", Kind: "server", Status: "error", StatusCode: 500, DurationMs: 40},
		{ProjectID: theirs.ProjectID, AppID: theirs.AppID, Environment: "production", Timestamp: now.Add(-time.Minute), TraceID: trace, SpanID: "10f067aa0ba902b7", Name: "secret span", Kind: "server", Status: "ok"},
	}))
	must(ins.Logs(ctx, []pipeline.LogRow{{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute), Level: "ERROR", Message: "boom", TraceID: trace}}))
	must(ins.Deploys(ctx, []pipeline.DeployRow{
		{ProjectID: mine.ProjectID, Environment: "production", Release: "v1", DeployedAt: now.Add(-30 * time.Minute)},
		{ProjectID: theirs.ProjectID, Environment: "production", Release: "secret-release", DeployedAt: now.Add(-30 * time.Minute)},
	}))

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier))
	query.Register(srv.API(), query.NewService(conn, q))
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(key, path string, out any) int {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+key)
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

	// The ingest key must not read data.
	if code := get(mine.APIKey, "/api/v1/traffic/summary", nil); code != http.StatusForbidden {
		t.Fatalf("ingest key read = %d, want 403", code)
	}

	var project struct {
		Project      struct{ Slug string }
		Apps         []struct{ Slug string }
		Environments []string
	}
	if code := get(mine.ReadKey, "/api/v1/project", &project); code != 200 || project.Project.Slug != "shop" || len(project.Apps) != 1 || project.Apps[0].Slug != "storefront" {
		t.Fatalf("project = %d %+v", code, project)
	}

	var summary struct {
		R    uint64  `json:"requests"`
		C    uint64  `json:"client_errors"`
		S    uint64  `json:"server_errors"`
		P50  float64 `json:"p50_ms"`
		Rate float64 `json:"error_rate"`
	}
	if code := get(mine.ReadKey, "/api/v1/traffic/summary?range=1h", &summary); code != 200 {
		t.Fatalf("summary = %d", code)
	}
	if summary.R != 4 || summary.C != 1 || summary.S != 1 || summary.Rate != 0.5 || summary.P50 <= 0 {
		t.Fatalf("summary = %+v (other project leaked or rollup wrong)", summary)
	}

	var series struct {
		BucketSeconds int `json:"bucket_seconds"`
		Points        []struct {
			Requests uint64 `json:"requests"`
		} `json:"points"`
	}
	if code := get(mine.ReadKey, "/api/v1/traffic/timeseries?range=1h", &series); code != 200 || series.BucketSeconds != 60 || len(series.Points) != 60 {
		t.Fatalf("timeseries = %d bucket=%d points=%d", code, series.BucketSeconds, len(series.Points))
	}
	var total uint64
	for _, p := range series.Points {
		total += p.Requests
	}
	if total != 4 {
		t.Fatalf("timeseries total = %d, want 4", total)
	}

	var endpoints struct {
		Endpoints []struct {
			Path     string `json:"path"`
			Requests uint64 `json:"requests"`
		} `json:"endpoints"`
	}
	if code := get(mine.ReadKey, "/api/v1/traffic/endpoints?range=1h", &endpoints); code != 200 || len(endpoints.Endpoints) != 1 || endpoints.Endpoints[0].Path != "/orders/{id}" {
		t.Fatalf("endpoints = %d %+v", code, endpoints)
	}

	var requests struct {
		Requests []struct {
			StatusCode int `json:"status_code"`
		} `json:"requests"`
	}
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h&status=5xx", &requests); code != 200 || len(requests.Requests) != 1 || requests.Requests[0].StatusCode != http.StatusInternalServerError {
		t.Fatalf("requests 5xx = %d %+v", code, requests)
	}

	var errs struct {
		Errors []struct {
			StatusCode int    `json:"status_code"`
			Count      uint64 `json:"count"`
		} `json:"errors"`
	}
	if code := get(mine.ReadKey, "/api/v1/errors?range=1h", &errs); code != 200 || len(errs.Errors) != 2 {
		t.Fatalf("errors = %d %+v", code, errs)
	}

	var tr struct {
		Spans []struct{ Name string }    `json:"spans"`
		Logs  []struct{ Message string } `json:"logs"`
	}
	if code := get(mine.ReadKey, "/api/v1/traces/"+trace, &tr); code != 200 || len(tr.Spans) != 1 || tr.Spans[0].Name != "GET /orders/{id}" || len(tr.Logs) != 1 {
		t.Fatalf("trace = %d %+v (shared trace id must not leak the other project's span)", code, tr)
	}
	if code := get(mine.ReadKey, "/api/v1/traces/"+uuid.NewString()[:8]+"0000000000000000000000ab", nil); code != http.StatusNotFound && code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown trace = %d", code)
	}

	var deploys struct {
		Deploys []struct{ Release string } `json:"deploys"`
	}
	if code := get(mine.ReadKey, "/api/v1/deploys?range=1h", &deploys); code != 200 || len(deploys.Deploys) != 1 || deploys.Deploys[0].Release != "v1" {
		t.Fatalf("deploys = %d %+v", code, deploys)
	}

	// And the other project sees only its own traffic.
	if code := get(theirs.ReadKey, "/api/v1/traffic/summary?range=1h", &summary); code != 200 || summary.R != 3 || summary.S != 2 {
		t.Fatalf("other project summary = %d %+v", code, summary)
	}
}
