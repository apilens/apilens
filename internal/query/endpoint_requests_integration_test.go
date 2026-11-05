//go:build integration

package query_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
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

type split struct {
	Requests     uint64 `json:"requests"`
	Successful   uint64 `json:"successful"`
	ClientErrors uint64 `json:"client_errors"`
	ServerErrors uint64 `json:"server_errors"`
}

type endpointRequests struct {
	Method        string `json:"method"`
	Path          string `json:"path"`
	BucketSeconds int    `json:"bucket_seconds"`
	Summary       struct {
		split
		RequestsPerMinute float64 `json:"requests_per_minute"`
	} `json:"summary"`
	Points []struct {
		TS time.Time `json:"ts"`
		split
	} `json:"points"`
	Consumers []struct {
		ConsumerID   string `json:"consumer_id"`
		ConsumerName string `json:"consumer_name"`
		split
	} `json:"consumers"`
}

// endpointRequestsEnv starts ClickHouse and Postgres, seeds two projects and
// serves the query API.
func endpointRequestsEnv(t *testing.T) (ctx context.Context, conn driver.Conn, mine, theirs bootstrap.Result, get func(key, path string, out any) int) {
	t.Helper()
	ctx = context.Background()
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
	t.Cleanup(func() { _ = conn.Close() })
	mine, err = bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err = bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	get = func(key, path string, out any) int {
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
	return ctx, conn, mine, theirs, get
}

func endpointURL(method, path, query string) string {
	return "/api/v1/endpoints/" + method + "/" + url.PathEscape(path) + "/requests?" + query
}

func TestEndpointRequests(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC()
	i := 0
	row := func(p bootstrap.Result, env, method, path string, code uint16, consumer, name string) pipeline.RequestRow {
		i++
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: env, Timestamp: now.Add(-time.Duration(i) * time.Minute),
			Method: method, Path: path, RawPath: path, StatusCode: code, ResponseTimeMs: 10, ConsumerID: consumer, ConsumerName: name,
		}
	}
	const tmpl = "/orders/{id}"
	rows := []pipeline.RequestRow{
		row(mine, "production", "GET", tmpl, 200, "alice", "Alice Old"),
		row(mine, "production", "GET", tmpl, 201, "alice", "Alice Old"),
		row(mine, "production", "GET", tmpl, 404, "alice", "Alice Old"),
		row(mine, "production", "GET", tmpl, 500, "bob", "Bob"),
		row(mine, "production", "GET", tmpl, 302, "", ""),
		row(mine, "staging", "GET", tmpl, 200, "carol", "Carol"),
		row(mine, "production", "POST", tmpl, 200, "alice", "Alice Old"),
		row(mine, "production", "GET", "/orders", 200, "alice", "Alice Old"),
		row(theirs, "production", "GET", tmpl, 500, "mallory", "Mallory"),
		row(theirs, "production", "GET", tmpl, 500, "mallory", "Mallory"),
	}
	// The newest alice row carries her new name.
	rows = append(rows, pipeline.RequestRow{
		ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-30 * time.Second),
		Method: "GET", Path: tmpl, RawPath: "/orders/9", StatusCode: 200, ResponseTimeMs: 10, ConsumerID: "alice", ConsumerName: "Alice",
	})
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	check := func(name, path string, want split, consumers ...string) endpointRequests {
		t.Helper()
		var out endpointRequests
		if code := get(mine.ReadKey, path, &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", name, code)
		}
		if out.Summary.split != want {
			t.Fatalf("%s: summary %+v, want %+v", name, out.Summary.split, want)
		}
		var total split
		for _, p := range out.Points {
			total.Requests += p.Requests
			total.Successful += p.Successful
			total.ClientErrors += p.ClientErrors
			total.ServerErrors += p.ServerErrors
		}
		if total != want {
			t.Fatalf("%s: points add up to %+v, want %+v", name, total, want)
		}
		var got []string
		for _, c := range out.Consumers {
			got = append(got, c.ConsumerID)
		}
		if !slices.Equal(got, consumers) {
			t.Fatalf("%s: consumers %v, want %v", name, got, consumers)
		}
		return out
	}

	// Rollup path: GET /orders/{id} in all environments of my project only.
	out := check("all", endpointURL("GET", tmpl, "range=1h"), split{7, 5, 1, 1}, "alice", "bob", "carol")
	if out.Method != "GET" || out.Path != tmpl || out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("all: method=%q path=%q bucket=%d points=%d", out.Method, out.Path, out.BucketSeconds, len(out.Points))
	}
	if r := out.Summary.RequestsPerMinute; r < 0.116 || r > 0.117 {
		t.Fatalf("all: rpm = %v, want 7/60", r)
	}
	alice := out.Consumers[0]
	if alice.ConsumerName != "Alice" || alice.split != (split{4, 3, 1, 0}) {
		t.Fatalf("all: alice = %+v", alice)
	}
	if out.Consumers[1].split != (split{1, 0, 0, 1}) {
		t.Fatalf("all: bob = %+v", out.Consumers[1])
	}

	// The method is case-insensitive.
	check("lowercase method", endpointURL("get", tmpl, "range=1h"), split{7, 5, 1, 1}, "alice", "bob", "carol")
	// Filters: environment (rollup), status and consumer (raw rows).
	check("env", endpointURL("GET", tmpl, "range=1h&env=production"), split{6, 4, 1, 1}, "alice", "bob")
	check("5xx", endpointURL("GET", tmpl, "range=1h&status=5xx"), split{1, 0, 0, 1}, "bob")
	check("2xx", endpointURL("GET", tmpl, "range=24h&status=2xx"), split{4, 4, 0, 0}, "alice", "carol")
	check("consumer", endpointURL("GET", tmpl, "range=7d&consumer=alice"), split{4, 3, 1, 0}, "alice")
	check("consumer+status", endpointURL("GET", tmpl, "range=6h&consumer=alice&status=4xx"), split{1, 0, 1, 0}, "alice")
	// Other method or path, and an unknown endpoint, are empty, not 404.
	check("POST", endpointURL("POST", tmpl, "range=1h"), split{1, 1, 0, 0}, "alice")
	check("unknown", endpointURL("GET", "/nope", "range=1h"), split{})

	// The other project sees only its own rows on the same template.
	var other endpointRequests
	if code := get(theirs.ReadKey, endpointURL("GET", tmpl, "range=1h"), &other); code != http.StatusOK ||
		other.Summary.split != (split{2, 0, 0, 2}) || len(other.Consumers) != 1 || other.Consumers[0].ConsumerID != "mallory" {
		t.Fatalf("other project = %d %+v", code, other)
	}

	// Bad input is rejected.
	for _, bad := range []string{
		endpointURL("G3T", tmpl, "range=1h"),
		endpointURL("GET", tmpl, "range=30d"),
		endpointURL("GET", tmpl, "status=6xx"),
	} {
		if code := get(mine.ReadKey, bad, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d, want 422", bad, code)
		}
	}
	if code := get(mine.APIKey, endpointURL("GET", tmpl, "range=1h"), nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}

// TestEndpointRequestsBenchmark checks the p95 < 300 ms budget of issue #571
// on 10M rows: 24h of traffic for one project over 40 endpoints and 5,000
// consumers. It is slow, so it only runs with APILENS_BENCH=1.
func TestEndpointRequestsBenchmark(t *testing.T) {
	if os.Getenv("APILENS_BENCH") == "" {
		t.Skip("set APILENS_BENCH=1 to run the 10M-row benchmark")
	}
	ctx, conn, mine, _, get := endpointRequestsEnv(t)
	const total, chunk = 10_000_000, 1_000_000
	start := time.Now()
	for off := 0; off < total; off += chunk {
		if err := conn.Exec(ctx, `
			INSERT INTO api_requests (project_id, app_id, environment, timestamp, method, path, raw_path,
			                          status_code, response_time_ms, consumer_id, consumer_name)
			SELECT ?, ?, if(number % 10 = 0, 'staging', 'production'),
			       now64(3) - toIntervalMillisecond(number % 86400000),
			       'GET', concat('/r', toString(number % 40), '/{id}'), concat('/r', toString(number % 40), '/', toString(number)),
			       multiIf(number % 50 = 0, 500, number % 20 = 0, 404, 200), (number % 1000) / 3.0,
			       concat('c', toString(number % 5000)), concat('Consumer ', toString(number % 5000))
			FROM numbers(?, ?)`, mine.ProjectID, mine.AppID, off, chunk); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("seeded %d rows in %v", total, time.Since(start))

	for _, c := range []struct{ name, query string }{
		{"rollup", "range=24h"},
		{"status", "range=24h&status=5xx"},
		{"consumer", "range=24h&consumer=c40"},
	} {
		var took []time.Duration
		for range 40 {
			var out endpointRequests
			t0 := time.Now()
			if code := get(mine.ReadKey, endpointURL("GET", "/r0/{id}", c.query), &out); code != http.StatusOK {
				t.Fatalf("%s: status %d", c.name, code)
			}
			took = append(took, time.Since(t0))
			if out.Summary.Requests == 0 {
				t.Fatalf("%s: no requests", c.name)
			}
		}
		slices.Sort(took)
		p95 := took[len(took)*95/100-1]
		t.Logf("%s: p50=%v p95=%v", c.name, took[len(took)/2], p95)
		if p95 > 300*time.Millisecond {
			t.Errorf("%s: p95 %v over the 300 ms budget", c.name, p95)
		}
	}
}
