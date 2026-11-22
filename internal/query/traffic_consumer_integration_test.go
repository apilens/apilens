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

// TestTrafficByConsumer: the Traffic page's consumer filter narrows the summary, the timeseries
// and the endpoints list to one consumer's requests (read from the raw requests, as the rollups
// aren't kept by consumer), and leaves out declared routes the consumer never called.
func TestTrafficByConsumer(t *testing.T) {
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
	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	get := func(path string, out any) int {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+mine.ReadKey)
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

	now := time.Now().UTC()
	row := func(ago time.Duration, method, path string, code uint16, ms float64, consumer string) pipeline.RequestRow {
		return pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-ago),
			Method: method, Path: path, RawPath: path, StatusCode: code, ResponseTimeMs: ms, ConsumerID: consumer,
		}
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, []pipeline.RequestRow{
		// acme: 3 requests on two routes, one 404 and one 500.
		row(30*time.Minute, "GET", "/orders", 200, 100, "acme"),
		row(20*time.Minute, "GET", "/orders", 404, 300, "acme"),
		row(10*time.Minute, "POST", "/charge", 500, 900, "acme"),
		// beta: 2 requests on /orders only; anonymous: 1.
		row(25*time.Minute, "GET", "/orders", 200, 20, "beta"),
		row(15*time.Minute, "GET", "/orders", 200, 20, "beta"),
		row(5*time.Minute, "GET", "/search", 200, 50, ""),
	}); err != nil {
		t.Fatal(err)
	}

	type totals struct {
		Requests     uint64  `json:"requests"`
		ClientErrors uint64  `json:"client_errors"`
		ServerErrors uint64  `json:"server_errors"`
		P95Ms        float64 `json:"p95_ms"`
	}
	var all, acme, beta totals
	for _, c := range []struct {
		query string
		out   *totals
		want  [3]uint64
	}{
		{"", &all, [3]uint64{6, 1, 1}},
		{"&consumer=acme", &acme, [3]uint64{3, 1, 1}},
		{"&consumer=beta", &beta, [3]uint64{2, 0, 0}},
	} {
		if code := get("/api/v1/traffic/summary?range=1h"+c.query, c.out); code != http.StatusOK {
			t.Fatalf("summary %q: %d", c.query, code)
		}
		if got := [3]uint64{c.out.Requests, c.out.ClientErrors, c.out.ServerErrors}; got != c.want {
			t.Fatalf("summary %q = %v, want %v", c.query, got, c.want)
		}
	}
	if beta.P95Ms > 25 || acme.P95Ms < 300 {
		t.Fatalf("p95: beta %v (want ~20), acme %v (want toward 900)", beta.P95Ms, acme.P95Ms)
	}
	var none totals
	if code := get("/api/v1/traffic/summary?range=1h&consumer=nobody", &none); code != http.StatusOK || none.Requests != 0 {
		t.Fatalf("unknown consumer: %d %+v", code, none)
	}

	// The timeseries counts the consumer's requests per bucket, at the same bucket width.
	var series struct {
		BucketSeconds int `json:"bucket_seconds"`
		Points        []struct {
			Requests     uint64 `json:"requests"`
			ServerErrors uint64 `json:"server_errors"`
		} `json:"points"`
	}
	if code := get("/api/v1/traffic/timeseries?range=1h&consumer=acme", &series); code != http.StatusOK {
		t.Fatalf("timeseries: %d", code)
	}
	var n, s5 uint64
	for _, p := range series.Points {
		n += p.Requests
		s5 += p.ServerErrors
	}
	if series.BucketSeconds != 60 || len(series.Points) != 60 || n != 3 || s5 != 1 {
		t.Fatalf("acme timeseries: bucket %d, %d points, %d requests, %d 5xx", series.BucketSeconds, len(series.Points), n, s5)
	}

	// The endpoints list holds only the routes the consumer called, with its numbers.
	var eps struct {
		Endpoints []struct {
			Method       string  `json:"method"`
			Path         string  `json:"path"`
			Requests     uint64  `json:"requests"`
			ClientErrors uint64  `json:"client_errors"`
			TotalTimeMs  float64 `json:"total_time_ms"`
		} `json:"endpoints"`
	}
	if code := get("/api/v1/traffic/endpoints?range=1h&consumer=acme", &eps); code != http.StatusOK {
		t.Fatalf("endpoints: %d", code)
	}
	if len(eps.Endpoints) != 2 {
		t.Fatalf("acme endpoints = %+v", eps.Endpoints)
	}
	for _, e := range eps.Endpoints {
		switch e.Method + " " + e.Path {
		case "GET /orders":
			if e.Requests != 2 || e.ClientErrors != 1 || e.TotalTimeMs != 400 {
				t.Fatalf("acme GET /orders = %+v", e)
			}
		case "POST /charge":
			if e.Requests != 1 || e.TotalTimeMs != 900 {
				t.Fatalf("acme POST /charge = %+v", e)
			}
		default:
			t.Fatalf("acme called no %s %s", e.Method, e.Path)
		}
	}
	// With the route filter too.
	if code := get("/api/v1/traffic/endpoints?range=1h&consumer=beta&method=POST", &eps); code != http.StatusOK || len(eps.Endpoints) != 0 {
		t.Fatalf("beta POST: %d %+v", code, eps.Endpoints)
	}
	// The latency report reads the consumer's requests too.
	var lat struct {
		Summary struct {
			Requests uint64 `json:"requests"`
		} `json:"summary"`
	}
	if code := get("/api/v1/traffic/latency?range=1h&consumer=beta", &lat); code != http.StatusOK || lat.Summary.Requests != 2 {
		t.Fatalf("beta latency: %d %+v", code, lat.Summary)
	}
}
