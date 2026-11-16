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

type anonymousCallers struct {
	Totals  split `json:"totals"`
	Callers []struct {
		IPAddress string    `json:"ip_address"`
		UserAgent string    `json:"user_agent"`
		LastSeen  time.Time `json:"last_seen"`
		split
	} `json:"callers"`
}

// TestAnonymousCallers drives the Consumers fallback (#989) against
// ClickHouse: requests without a consumer counted by outcome, grouped by
// client IP and user agent, most requests first; identified requests, other
// environments, rows outside the range and other projects left out.
func TestAnonymousCallers(t *testing.T) {
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

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
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

	const curl, browser = "curl/8.7.1", "Mozilla/5.0"
	now := time.Now().UTC()
	row := func(p bootstrap.Result, ago time.Duration, code uint16, env, ip, ua, consumer string) pipeline.RequestRow {
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: env, Timestamp: now.Add(-ago),
			Method: "GET", Path: "/orders", RawPath: "/orders", StatusCode: code, ResponseTimeMs: 10,
			IPAddress: ip, UserAgent: ua, ConsumerID: consumer,
		}
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, []pipeline.RequestRow{
		row(mine, 10*time.Minute, 200, "production", "10.0.0.1", curl, ""),
		row(mine, 8*time.Minute, 404, "production", "10.0.0.1", curl, ""),
		row(mine, 6*time.Minute, 500, "production", "10.0.0.1", curl, ""),
		// Same IP, another user agent: its own caller.
		row(mine, 4*time.Minute, 200, "production", "10.0.0.1", browser, ""),
		row(mine, 2*time.Minute, 200, "staging", "10.0.0.2", browser, ""),
		// Identified, out of range and another project's rows never count.
		row(mine, 3*time.Minute, 200, "production", "10.0.0.9", curl, "usr_1"),
		row(mine, 3*time.Hour, 200, "production", "10.0.0.8", curl, ""),
		row(theirs, 3*time.Minute, 200, "production", "10.0.0.7", curl, ""),
	}); err != nil {
		t.Fatal(err)
	}

	var got anonymousCallers
	if code := get(mine.ReadKey, "/api/v1/anonymous-callers?range=1h", &got); code != http.StatusOK {
		t.Fatalf("1h: %d", code)
	}
	if got.Totals != (split{5, 3, 1, 1}) {
		t.Fatalf("1h totals = %+v", got.Totals)
	}
	if len(got.Callers) != 3 {
		t.Fatalf("1h callers = %+v", got.Callers)
	}
	top := got.Callers[0]
	if top.IPAddress != "10.0.0.1" || top.UserAgent != curl || top.split != (split{3, 1, 1, 1}) {
		t.Fatalf("top caller = %+v", top)
	}
	if d := now.Add(-6 * time.Minute).Sub(top.LastSeen); d < -time.Second || d > time.Second {
		t.Fatalf("top last_seen = %v", top.LastSeen)
	}
	// Ties on requests: the latest caller first.
	if got.Callers[1].IPAddress != "10.0.0.2" || got.Callers[2].UserAgent != browser || got.Callers[2].IPAddress != "10.0.0.1" {
		t.Fatalf("1h callers = %+v", got.Callers)
	}

	if code := get(mine.ReadKey, "/api/v1/anonymous-callers?range=1h&env=production&limit=1", &got); code != http.StatusOK {
		t.Fatalf("production: %d", code)
	}
	if got.Totals.Requests != 4 || len(got.Callers) != 1 || got.Callers[0].Requests != 3 {
		t.Fatalf("production = %+v", got)
	}

	if code := get(mine.ReadKey, "/api/v1/anonymous-callers?range=24h", &got); code != http.StatusOK {
		t.Fatalf("24h: %d", code)
	}
	if got.Totals.Requests != 6 || len(got.Callers) != 4 {
		t.Fatalf("24h = %+v", got)
	}

	// The other project sees only its own anonymous request.
	if code := get(theirs.ReadKey, "/api/v1/anonymous-callers?range=1h", &got); code != http.StatusOK {
		t.Fatalf("theirs: %d", code)
	}
	if got.Totals.Requests != 1 || len(got.Callers) != 1 || got.Callers[0].IPAddress != "10.0.0.7" {
		t.Fatalf("theirs = %+v", got)
	}

	// limit is bounded by the API.
	if code := get(mine.ReadKey, "/api/v1/anonymous-callers?range=1h&limit=101", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("limit 101: %d", code)
	}
}
