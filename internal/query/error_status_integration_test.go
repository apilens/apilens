//go:build integration

package query_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
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

type errorStatuses struct {
	BucketSeconds int        `json:"bucket_seconds"`
	Summary       errorSplit `json:"summary"`
	Points        []struct {
		TS time.Time `json:"ts"`
		errorSplit
	} `json:"points"`
	Series []struct {
		StatusCode int      `json:"status_code"`
		Counts     []uint64 `json:"counts"`
	} `json:"series"`
	Statuses []struct {
		StatusCode int       `json:"status_code"`
		Count      uint64    `json:"count"`
		Share      float64   `json:"share"`
		Endpoints  uint64    `json:"endpoints"`
		Consumers  uint64    `json:"consumers"`
		FirstSeen  time.Time `json:"first_seen"`
		LastSeen   time.Time `json:"last_seen"`
	} `json:"statuses"`
}

type errorStatusDetail struct {
	StatusCode    int        `json:"status_code"`
	BucketSeconds int        `json:"bucket_seconds"`
	Occurrences   uint64     `json:"occurrences"`
	Requests      uint64     `json:"requests"`
	Share         float64    `json:"share"`
	PerHour       float64    `json:"per_hour"`
	Consumers     uint64     `json:"consumers"`
	Anonymous     uint64     `json:"anonymous"`
	Endpoints     uint64     `json:"endpoints"`
	FirstSeen     *time.Time `json:"first_seen"`
	LastSeen      *time.Time `json:"last_seen"`
	Points        []struct {
		TS    time.Time `json:"ts"`
		Count uint64    `json:"count"`
	} `json:"points"`
	EndpointBreakdown []struct {
		Method           string `json:"method"`
		Path             string `json:"path"`
		Count            uint64 `json:"count"`
		Consumers        uint64 `json:"consumers"`
		ValidationErrors uint64 `json:"validation_errors"`
		Exceptions       uint64 `json:"exceptions"`
	} `json:"endpoint_breakdown"`
	ConsumerBreakdown []struct {
		ConsumerID   string  `json:"consumer_id"`
		ConsumerName string  `json:"consumer_name"`
		Count        uint64  `json:"count"`
		Share        float64 `json:"share"`
	} `json:"consumer_breakdown"`
}

// TestErrorStatus seeds requests and exception logs across endpoints,
// environments and two projects, and checks the status-centric errors
// dashboard: the 4xx/5xx and per-code trend, the status table, the detail
// of one code with its endpoint and consumer breakdowns, that expected
// status codes and excluded endpoints are left out, the env filter,
// project isolation and input validation.
func TestErrorStatus(t *testing.T) {
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

	const orders, internal = "/orders/{id}", "/internal/jobs"
	now := time.Now().UTC()
	i := 0
	ago := func() time.Time { i++; return now.Add(-time.Duration(i) * time.Minute) }
	req := func(p bootstrap.Result, env, method, path string, code uint16, consumer string, ve ...pipeline.ValidationError) pipeline.RequestRow {
		name := ""
		if consumer != "" {
			name = consumer + " inc"
		}
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: env, Timestamp: ago(), Method: method, Path: path, RawPath: path,
			StatusCode: code, ResponseTimeMs: 10, ConsumerID: consumer, ConsumerName: name, Sampled: true, ValidationErrors: ve,
		}
	}
	qty := pipeline.ValidationError{Loc: "body.qty", Msg: "must be > 0", Type: "value_error"}
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, []pipeline.RequestRow{
		req(mine, "production", "GET", orders, 200, "alice"),
		req(mine, "production", "GET", orders, 404, "alice"),
		req(mine, "production", "GET", orders, 404, "alice"),
		req(mine, "production", "GET", orders, 404, "bob"),
		req(mine, "production", "GET", orders, 404, ""),
		req(mine, "production", "POST", orders, 404, "carol"),
		req(mine, "production", "GET", orders, 409, "alice"),
		req(mine, "production", "GET", orders, 422, "alice", qty),
		req(mine, "production", "GET", orders, 500, "bob"),
		req(mine, "production", "POST", orders, 500, "alice", qty),
		req(mine, "staging", "GET", orders, 503, "carol"),
		req(mine, "production", "GET", internal, 500, "dave"),
		req(theirs, "production", "GET", orders, 404, "mallory"),
	}); err != nil {
		t.Fatal(err)
	}
	log := func(p bootstrap.Result, method string, code uint16, loggerName, level string) pipeline.LogRow {
		return pipeline.LogRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: "production", Timestamp: ago(), Level: level, Message: "ValueError: boom",
			LoggerName: loggerName, EndpointMethod: method, EndpointPath: orders, StatusCode: code, ConsumerID: "bob",
		}
	}
	const exc = "apilens.exception"
	if err := ins.Logs(ctx, []pipeline.LogRow{
		log(mine, "GET", 500, exc, "ERROR"),
		log(mine, "GET", 500, exc, "INFO"),             // not an error record
		log(mine, "GET", 500, "apilens.http", "ERROR"), // not an exception
		log(mine, "GET", 404, exc, "ERROR"),            // another status code
		log(theirs, "GET", 500, exc, "ERROR"),
	}); err != nil {
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
		r, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		r.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(r)
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
	overview := func(name, key, query string) errorStatuses {
		t.Helper()
		var out errorStatuses
		if code := get(key, "/api/v1/errors/status?"+query, &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", name, code)
		}
		var total errorSplit
		for _, p := range out.Points {
			total.Requests += p.Requests
			total.ClientErrors += p.ClientErrors
			total.ServerErrors += p.ServerErrors
		}
		if total.Requests != out.Summary.Requests || total.ClientErrors != out.Summary.ClientErrors || total.ServerErrors != out.Summary.ServerErrors {
			t.Fatalf("%s: points add up to %+v, summary %+v", name, total, out.Summary)
		}
		if len(out.Series) != len(out.Statuses) {
			t.Fatalf("%s: %d series for %d statuses", name, len(out.Series), len(out.Statuses))
		}
		for k, s := range out.Series {
			var sum uint64
			for _, n := range s.Counts {
				sum += n
			}
			if s.StatusCode != out.Statuses[k].StatusCode || len(s.Counts) != len(out.Points) || sum != out.Statuses[k].Count {
				t.Fatalf("%s: series %d = %+v, status %+v", name, k, s, out.Statuses[k])
			}
		}
		return out
	}
	detail := func(name, key, path string) errorStatusDetail {
		t.Helper()
		var out errorStatusDetail
		if code := get(key, path, &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", name, code)
		}
		var sum uint64
		for _, p := range out.Points {
			sum += p.Count
		}
		if sum != out.Occurrences {
			t.Fatalf("%s: points add up to %d, occurrences %d", name, sum, out.Occurrences)
		}
		if out.EndpointBreakdown == nil || out.ConsumerBreakdown == nil {
			t.Fatalf("%s: null breakdowns", name)
		}
		return out
	}
	codes := func(out errorStatuses) (got []int) {
		for _, s := range out.Statuses {
			got = append(got, s.StatusCode)
		}
		return got
	}

	// Before any settings: 12 requests, 409 is a client error and the
	// internal endpoint counts.
	out := overview("no settings", mine.ReadKey, "range=1h")
	if s := out.Summary; s.Requests != 12 || s.ClientErrors != 7 || s.ServerErrors != 4 {
		t.Fatalf("no settings: summary %+v", s)
	}
	if got := codes(out); !slices.Equal(got, []int{404, 500, 409, 422, 503}) {
		t.Fatalf("no settings: statuses %v", got)
	}

	// 409 is expected on GET /orders/{id}; the internal endpoint is excluded.
	for _, p := range []db.UpsertEndpointSettingsParams{
		{AppID: mine.AppID, Method: "GET", Path: orders, ExpectedStatusCodes: []int32{409}},
		{AppID: mine.AppID, Method: "GET", Path: internal, ExpectedStatusCodes: []int32{}, Excluded: true},
	} {
		if _, err := q.UpsertEndpointSettings(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	out = overview("settings", mine.ReadKey, "range=1h")
	if out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("settings: bucket=%d points=%d", out.BucketSeconds, len(out.Points))
	}
	if s := out.Summary; s.Requests != 11 || s.ClientErrors != 6 || s.ServerErrors != 3 {
		t.Fatalf("settings: summary %+v", s)
	}
	if got := codes(out); !slices.Equal(got, []int{404, 500, 422, 503}) {
		t.Fatalf("settings: statuses %v", got)
	}
	if s := out.Statuses[0]; s.Count != 5 || s.Endpoints != 2 || s.Consumers != 3 || s.Share != 5.0/11 ||
		s.FirstSeen.IsZero() || s.FirstSeen.After(s.LastSeen) {
		t.Fatalf("settings: 404 = %+v", s)
	}

	// Detail of 404.
	d := detail("404", mine.ReadKey, "/api/v1/errors/status/404?range=1h")
	if d.StatusCode != http.StatusNotFound || d.BucketSeconds != 60 || len(d.Points) != 60 || d.Occurrences != 5 || d.Requests != 11 ||
		d.Share != 5.0/11 || d.PerHour != 5 || d.Consumers != 3 || d.Anonymous != 1 || d.Endpoints != 2 ||
		d.FirstSeen == nil || d.LastSeen == nil || d.FirstSeen.After(*d.LastSeen) {
		t.Fatalf("404: %+v", d)
	}
	if e := d.EndpointBreakdown; len(e) != 2 || e[0].Method != http.MethodGet || e[0].Path != orders || e[0].Count != 4 || e[0].Consumers != 2 ||
		e[0].Exceptions != 1 || e[1].Method != http.MethodPost || e[1].Count != 1 {
		t.Fatalf("404: endpoints %+v", e)
	}
	if c := d.ConsumerBreakdown; len(c) != 3 || c[0].ConsumerID != "alice" || c[0].ConsumerName != "alice inc" || c[0].Count != 2 ||
		c[0].Share != 0.4 || c[1].ConsumerID != "bob" || c[2].ConsumerID != "carol" {
		t.Fatalf("404: consumers %+v", c)
	}

	// 500: the excluded endpoint is left out; exceptions and validation
	// errors point at their endpoint.
	d = detail("500", mine.ReadKey, "/api/v1/errors/status/500?range=24h")
	if d.Occurrences != 2 || d.Endpoints != 2 || d.Consumers != 2 || d.BucketSeconds != 900 {
		t.Fatalf("500: %+v", d)
	}
	for _, e := range d.EndpointBreakdown {
		if e.Path == internal {
			t.Fatalf("500: excluded endpoint listed: %+v", e)
		}
		if e.Method == http.MethodGet && (e.Exceptions != 1 || e.ValidationErrors != 0) ||
			e.Method == http.MethodPost && (e.Exceptions != 0 || e.ValidationErrors != 1) {
			t.Fatalf("500: endpoint %+v", e)
		}
	}

	// 409 is expected everywhere it occurred: no occurrences, not a 404.
	d = detail("409", mine.ReadKey, "/api/v1/errors/status/409?range=1h")
	if d.Occurrences != 0 || d.Requests != 11 || d.FirstSeen != nil || d.LastSeen != nil || len(d.Points) != 60 ||
		len(d.EndpointBreakdown) != 0 || len(d.ConsumerBreakdown) != 0 {
		t.Fatalf("409: %+v", d)
	}

	// Environment filter.
	out = overview("staging", mine.ReadKey, "range=6h&env=staging")
	if s := out.Summary; s.Requests != 1 || s.ServerErrors != 1 || !slices.Equal(codes(out), []int{503}) {
		t.Fatalf("staging: %+v", out)
	}
	if d = detail("503 production", mine.ReadKey, "/api/v1/errors/status/503?range=7d&env=production"); d.Occurrences != 0 {
		t.Fatalf("503 production: %+v", d)
	}

	// The other project sees only its own rows; my settings do not apply.
	out = overview("other", theirs.ReadKey, "range=1h")
	if s := out.Summary; s.Requests != 1 || s.ClientErrors != 1 || !slices.Equal(codes(out), []int{404}) {
		t.Fatalf("other: %+v", out)
	}
	d = detail("other 404", theirs.ReadKey, "/api/v1/errors/status/404?range=1h")
	if d.Occurrences != 1 || len(d.ConsumerBreakdown) != 1 || d.ConsumerBreakdown[0].ConsumerID != "mallory" {
		t.Fatalf("other 404: %+v", d)
	}

	// Bad input is rejected.
	for _, bad := range []string{
		"/api/v1/errors/status/399?range=1h", "/api/v1/errors/status/600?range=1h",
		"/api/v1/errors/status/abc?range=1h", "/api/v1/errors/status?range=30d",
	} {
		if code := get(mine.ReadKey, bad, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d, want 422", bad, code)
		}
	}
	if code := get(mine.APIKey, "/api/v1/errors/status?range=1h", nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}
