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

type errorSplit struct {
	Requests        uint64  `json:"requests"`
	ClientErrors    uint64  `json:"client_errors"`
	ServerErrors    uint64  `json:"server_errors"`
	ClientErrorRate float64 `json:"client_error_rate"`
	ServerErrorRate float64 `json:"server_error_rate"`
}

type endpointErrors struct {
	Method        string     `json:"method"`
	Path          string     `json:"path"`
	BucketSeconds int        `json:"bucket_seconds"`
	Summary       errorSplit `json:"summary"`
	Points        []struct {
		TS time.Time `json:"ts"`
		errorSplit
	} `json:"points"`
	Statuses []struct {
		StatusCode int       `json:"status_code"`
		Count      uint64    `json:"count"`
		Share      float64   `json:"share"`
		Consumers  uint64    `json:"consumers"`
		LastSeen   time.Time `json:"last_seen"`
	} `json:"statuses"`
	ValidationErrors []struct {
		Loc       string `json:"loc"`
		Msg       string `json:"msg"`
		Type      string `json:"type"`
		Count     uint64 `json:"count"`
		Consumers uint64 `json:"consumers"`
	} `json:"validation_errors"`
	Exceptions []struct {
		ExceptionType string    `json:"exception_type"`
		Message       string    `json:"message"`
		Count         uint64    `json:"count"`
		Consumers     uint64    `json:"consumers"`
		FirstSeen     time.Time `json:"first_seen"`
		LastSeen      time.Time `json:"last_seen"`
		StackTrace    string    `json:"stack_trace"`
		TraceID       string    `json:"trace_id"`
	} `json:"exceptions"`
}

// TestEndpointErrors seeds requests (with validation errors) and exception
// logs for one endpoint plus noise around it, and checks the Errors tab:
// the error split and trend, the status breakdown, the validation-error and
// exception tables, the env and consumer filters, project isolation, and
// that a status code marked expected in the endpoint settings is no error.
func TestEndpointErrors(t *testing.T) {
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

	const tmpl = "/orders/{id}"
	now := time.Now().UTC()
	i := 0
	ago := func() time.Time { i++; return now.Add(-time.Duration(i) * time.Minute) }
	req := func(p bootstrap.Result, env, method string, code uint16, consumer string, ve ...pipeline.ValidationError) pipeline.RequestRow {
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: env, Timestamp: ago(), Method: method, Path: tmpl, RawPath: "/orders/1",
			StatusCode: code, ResponseTimeMs: 10, ConsumerID: consumer, Sampled: true, ValidationErrors: ve,
		}
	}
	qty := pipeline.ValidationError{Loc: "body.qty", Msg: "must be > 0", Type: "value_error"}
	sku := pipeline.ValidationError{Loc: "body.sku", Msg: "field required", Type: "missing"}
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, []pipeline.RequestRow{
		req(mine, "production", "GET", 200, "alice"),
		req(mine, "production", "GET", 404, "alice"),
		req(mine, "production", "GET", 404, "bob"),
		req(mine, "production", "GET", 409, "alice"),
		req(mine, "production", "GET", 422, "alice", qty, sku),
		req(mine, "production", "GET", 422, "bob", qty),
		req(mine, "production", "GET", 500, "bob"),
		req(mine, "staging", "GET", 503, "carol"),
		req(mine, "production", "POST", 500, "alice", qty),
		req(theirs, "production", "GET", 500, "mallory", sku),
	}); err != nil {
		t.Fatal(err)
	}
	log := func(p bootstrap.Result, method, level, loggerName, msg, consumer, payload, trace string) pipeline.LogRow {
		return pipeline.LogRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: "production", Timestamp: ago(), Level: level, Message: msg,
			LoggerName: loggerName, EndpointMethod: method, EndpointPath: tmpl, StatusCode: 500, ConsumerID: consumer,
			TraceID: trace, Payload: payload,
		}
	}
	const exc = "apilens.exception"
	if err := ins.Logs(ctx, []pipeline.LogRow{
		log(mine, "GET", "ERROR", exc, "ValueError: bad qty", "alice", "Traceback new", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
		log(mine, "GET", "ERROR", exc, "ValueError: bad qty", "bob", "Traceback old", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
		log(mine, "GET", "CRITICAL", exc, "KeyError: 'sku'", "bob", "Traceback key", ""),
		log(mine, "GET", "ERROR", "apilens.http", "HTTP 503 on GET /orders/{id}", "carol", "", ""),
		log(mine, "GET", "INFO", exc, "ValueError: not an error", "alice", "", ""),
		log(mine, "POST", "ERROR", exc, "RuntimeError: other method", "alice", "", ""),
		log(theirs, "GET", "ERROR", exc, "LedgerError: theirs", "mallory", "", ""),
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
	errorsURL := func(method, query string) string {
		return "/api/v1/endpoints/" + method + "/" + url.PathEscape(tmpl) + "/errors?" + query
	}
	fetch := func(name, key, path string) endpointErrors {
		t.Helper()
		var out endpointErrors
		if code := get(key, path, &out); code != http.StatusOK {
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
		return out
	}
	statuses := func(out endpointErrors) (got []int) {
		for _, s := range out.Statuses {
			got = append(got, s.StatusCode)
		}
		return got
	}

	// Before any settings 409 is a client error.
	out := fetch("no settings", mine.ReadKey, errorsURL("GET", "range=1h"))
	if s := out.Summary; s.Requests != 8 || s.ClientErrors != 5 || s.ServerErrors != 2 {
		t.Fatalf("no settings: summary %+v", s)
	}
	if got := statuses(out); !slices.Equal(got, []int{404, 422, 409, 500, 503}) {
		t.Fatalf("no settings: statuses %v", got)
	}

	// Mark 409 expected (and 200, which is never an error anyway).
	if _, err := q.UpsertEndpointSettings(ctx, db.UpsertEndpointSettingsParams{
		AppID: mine.AppID, Method: "GET", Path: tmpl, ExpectedStatusCodes: []int32{200, 409},
	}); err != nil {
		t.Fatal(err)
	}
	out = fetch("all", mine.ReadKey, errorsURL("get", "range=1h"))
	if out.Method != http.MethodGet || out.Path != tmpl || out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("all: method=%q path=%q bucket=%d points=%d", out.Method, out.Path, out.BucketSeconds, len(out.Points))
	}
	if s := out.Summary; s.Requests != 8 || s.ClientErrors != 4 || s.ServerErrors != 2 || s.ClientErrorRate != 0.5 || s.ServerErrorRate != 0.25 {
		t.Fatalf("all: summary %+v", s)
	}
	if got := statuses(out); !slices.Equal(got, []int{404, 422, 500, 503}) {
		t.Fatalf("all: statuses %v", got)
	}
	if s := out.Statuses[0]; s.Count != 2 || s.Share != 0.25 || s.Consumers != 2 || s.LastSeen.IsZero() {
		t.Fatalf("all: 404 = %+v", s)
	}
	for _, p := range out.Points {
		if p.Requests > 0 && p.ClientErrorRate+p.ServerErrorRate > 1 {
			t.Fatalf("all: point %+v", p)
		}
	}
	if v := out.ValidationErrors; len(v) != 2 ||
		v[0].Loc != "body.qty" || v[0].Msg != "must be > 0" || v[0].Type != "value_error" || v[0].Count != 2 || v[0].Consumers != 2 ||
		v[1].Loc != "body.sku" || v[1].Type != "missing" || v[1].Count != 1 {
		t.Fatalf("all: validation errors %+v", v)
	}
	if e := out.Exceptions; len(e) != 2 ||
		e[0].ExceptionType != "ValueError" || e[0].Message != "bad qty" || e[0].Count != 2 || e[0].Consumers != 2 ||
		e[0].StackTrace != "Traceback new" || e[0].TraceID != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || !e[0].FirstSeen.Before(e[0].LastSeen) ||
		e[1].ExceptionType != "KeyError" || e[1].Message != "'sku'" || e[1].Count != 1 || e[1].StackTrace != "Traceback key" {
		t.Fatalf("all: exceptions %+v", e)
	}

	// Filters: environment and consumer.
	out = fetch("env", mine.ReadKey, errorsURL("GET", "range=6h&env=production"))
	if s := out.Summary; s.Requests != 7 || s.ClientErrors != 4 || s.ServerErrors != 1 {
		t.Fatalf("env: summary %+v", s)
	}
	out = fetch("consumer", mine.ReadKey, errorsURL("GET", "range=24h&consumer=alice"))
	if s := out.Summary; s.Requests != 4 || s.ClientErrors != 2 || s.ServerErrors != 0 {
		t.Fatalf("consumer: summary %+v", s)
	}
	if len(out.ValidationErrors) != 2 || out.ValidationErrors[0].Count != 1 || len(out.Exceptions) != 1 || out.Exceptions[0].Count != 1 {
		t.Fatalf("consumer: validation %+v exceptions %+v", out.ValidationErrors, out.Exceptions)
	}
	// Another method of the same template.
	out = fetch("POST", mine.ReadKey, errorsURL("POST", "range=7d"))
	if out.Summary.ServerErrors != 1 || len(out.ValidationErrors) != 1 || len(out.Exceptions) != 1 || out.Exceptions[0].ExceptionType != "RuntimeError" {
		t.Fatalf("POST: %+v", out)
	}
	// An unknown endpoint is empty, not 404, with empty (not null) lists.
	out = fetch("unknown", mine.ReadKey, "/api/v1/endpoints/GET/"+url.PathEscape("/nope")+"/errors?range=1h")
	if out.Summary.Requests != 0 || out.Statuses == nil || out.ValidationErrors == nil || out.Exceptions == nil {
		t.Fatalf("unknown: %+v", out)
	}

	// The other project sees only its own rows; my settings do not apply.
	out = fetch("other", theirs.ReadKey, errorsURL("GET", "range=1h"))
	if out.Summary.Requests != 1 || out.Summary.ServerErrors != 1 || len(out.ValidationErrors) != 1 ||
		len(out.Exceptions) != 1 || out.Exceptions[0].ExceptionType != "LedgerError" {
		t.Fatalf("other: %+v", out)
	}

	// Bad input is rejected.
	for _, bad := range []string{errorsURL("G3T", "range=1h"), errorsURL("GET", "range=30d")} {
		if code := get(mine.ReadKey, bad, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d, want 422", bad, code)
		}
	}
	if code := get(mine.APIKey, errorsURL("GET", "range=1h"), nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}
