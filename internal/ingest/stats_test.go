package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"

	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/platform/config"
)

var billingApp = uuid.MustParse("33333333-3333-4333-8333-333333333333")

// twoApps resolves "storefront" and "billing".
type twoApps struct{}

func (twoApps) ResolveFor(_ context.Context, _ uuid.UUID, c catalog.Caller, idents []string) (catalog.Result, error) {
	return staticResolve(c, idents, map[string]uuid.UUID{"storefront": testApp, "billing": billingApp})
}

// memStats is an in-memory StatsStore.
type memStats struct {
	mu    sync.Mutex
	err   error
	days  map[string]bool
	byApp map[uuid.UUID]Counts
}

func (m *memStats) Add(_ context.Context, day time.Time, deltas map[uuid.UUID]Counts) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	if m.byApp == nil {
		m.byApp, m.days = map[uuid.UUID]Counts{}, map[string]bool{}
	}
	m.days[day.UTC().Format(time.DateOnly)] = true
	for id, c := range deltas {
		if c == (Counts{}) {
			return errors.New("zero delta written")
		}
		m.byApp[id] = m.byApp[id].Add(c)
	}
	return nil
}

func newStatsEdge(t *testing.T, stats StatsStore, q Quota) (*Edge, http.Handler) {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 16 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, twoApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry()).
		WithStats(stats).WithQuota(q)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return e, mux
}

func jsonBody(t *testing.T, key string, recs ...map[string]any) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{key: recs})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sumVec(v *prometheus.CounterVec, labels ...[]string) float64 {
	var n float64
	for _, l := range labels {
		n += promtest.ToFloat64(v.WithLabelValues(l...))
	}
	return n
}

// TestStatsMatchPrometheusTotals drives every ingest path that counts and
// checks that the per-app counters add up to the Prometheus totals.
func TestStatsMatchPrometheusTotals(t *testing.T) {
	stats := &memStats{}
	q := &fakeQuota{decision: QuotaDecision{Allowed: true}}
	e, h := newStatsEdge(t, stats, q)
	ts := "2026-10-22T11:59:00Z"
	big := `{"note":"` + strings.Repeat("x", defaultMaxPayloadBytes) + `"}`
	expect := func(path, body string, code int) {
		t.Helper()
		if rec := post(t, h, path, body, nil); rec.Code != code {
			t.Fatalf("%s: code = %d, want %d: %s", path, rec.Code, code, rec.Body)
		}
	}

	// Requests: storefront masked (Authorization header) and truncated twice
	// (request and response payload); billing masked (token query) and one
	// plain record.
	expect("/v1/requests", jsonBody(t, "requests",
		map[string]any{"app_id": "storefront", "timestamp": ts, "method": "POST", "path": "/orders", "status_code": 201,
			"request_headers": `{"authorization":"Bearer abc"}`, "request_payload": big, "response_payload": big},
		map[string]any{"app_id": "billing", "timestamp": ts, "method": "GET", "path": "/invoices", "raw_path": "/invoices?token=abc", "status_code": 200},
		map[string]any{"app_id": "billing", "timestamp": ts, "method": "GET", "path": "/invoices", "status_code": 200},
	), http.StatusOK)
	// Logs: one storefront log masked, one billing log plain.
	expect("/v1/logs", jsonBody(t, "logs",
		map[string]any{"app_id": "storefront", "timestamp": ts, "level": "ERROR", "message": "login failed password=hunter2"},
		map[string]any{"app_id": "billing", "timestamp": ts, "level": "INFO", "message": "invoice sent"},
	), http.StatusOK)
	expect("/v1/traces", jsonBody(t, "spans",
		map[string]any{"app_id": "billing", "timestamp": ts, "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7", "name": "GET /invoices"},
	), http.StatusOK)
	expect("/v1/deploys", jsonBody(t, "deploys",
		map[string]any{"app_id": "storefront", "release": "1.2.0"},
	), http.StatusOK)
	// OTLP: a valid and an invalid (no ids) storefront span.
	good := &tracepb.Span{TraceId: traceID, SpanId: spanID, Name: "GET /orders", StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 1}
	bad := &tracepb.Span{Name: "no ids", StartTimeUnixNano: startNs}
	if rec := otlpPost(t, h, "/otlp/v1/traces", &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{good, bad}}}},
	}}); rec.Code != http.StatusOK {
		t.Fatalf("otlp traces: code = %d", rec.Code)
	}

	// Quota refusals: two storefront requests, and an OTLP export with two
	// billing log records and one storefront log record.
	q.decision = QuotaDecision{Reason: ReasonRecordsPerMinute, RetryAfter: time.Second}
	expect("/v1/requests", jsonBody(t, "requests",
		map[string]any{"app_id": "storefront", "timestamp": ts, "method": "GET", "path": "/a", "status_code": 200},
		map[string]any{"app_id": " storefront ", "timestamp": ts, "method": "GET", "path": "/b", "status_code": 200},
	), http.StatusTooManyRequests)
	lr := &logspb.LogRecord{TimeUnixNano: startNs, Body: nil}
	if rec := otlpPost(t, h, "/otlp/v1/logs", &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{
		{Resource: resource("billing"), ScopeLogs: []*logspb.ScopeLogs{{LogRecords: []*logspb.LogRecord{lr, lr}}}},
		{Resource: resource("storefront"), ScopeLogs: []*logspb.ScopeLogs{{LogRecords: []*logspb.LogRecord{lr}}}},
	}}); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("otlp logs: code = %d", rec.Code)
	}

	want := map[uuid.UUID]Counts{
		testApp:    {Accepted: 1 + 1 + 1 + 1, Rejected: 1 + 2 + 1, Truncated: 2, Masked: 2},
		billingApp: {Accepted: 2 + 1 + 1, Rejected: 2, Masked: 1},
	}
	for id, w := range want {
		if got := stats.byApp[id]; got != w {
			t.Errorf("app %s: counts = %+v, want %+v", id, got, w)
		}
	}
	if len(stats.byApp) != 2 || !stats.days["2026-10-22"] || len(stats.days) != 1 {
		t.Errorf("stats = %+v", stats)
	}

	var total Counts
	for _, c := range stats.byApp {
		total = total.Add(c)
	}
	signals := []string{"requests", "logs", "spans", "deploys", "otlp_spans", "otlp_logs"}
	var accepted, rejected [][]string
	for _, s := range signals {
		accepted = append(accepted, []string{s, "accepted"})
		rejected = append(rejected, []string{s, "rejected"})
	}
	var fields [][]string
	for _, f := range truncatedFields {
		fields = append(fields, []string{f})
	}
	prom := Counts{
		Accepted:  int64(sumVec(e.records, accepted...)),
		Rejected:  int64(sumVec(e.records, rejected...)),
		Truncated: int64(sumVec(e.truncated, fields...)),
		Masked:    int64(sumVec(e.masked, []string{"requests"}, []string{"logs"})),
	}
	if total != prom {
		t.Fatalf("per-app sum = %+v, Prometheus totals = %+v", total, prom)
	}
}

// TestStatsFailOpen: an unavailable counter store never fails ingestion.
func TestStatsFailOpen(t *testing.T) {
	_, h := newStatsEdge(t, &memStats{err: errors.New("valkey down")}, nil)
	body := jsonBody(t, "requests", map[string]any{"app_id": "storefront", "timestamp": "2026-10-22T11:59:00Z", "method": "GET", "path": "/", "status_code": 200})
	if rec := post(t, h, "/v1/requests", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body)
	}
}

// TestStatsUnresolvedRejections: quota-refused records of an unknown app
// count in Prometheus only.
func TestStatsUnresolvedRejections(t *testing.T) {
	stats := &memStats{}
	e, h := newStatsEdge(t, stats, &fakeQuota{decision: QuotaDecision{Reason: ReasonBytesPerDay}})
	body := jsonBody(t, "requests", map[string]any{"app_id": "nope", "timestamp": "2026-10-22T11:59:00Z", "method": "GET", "path": "/", "status_code": 200})
	if rec := post(t, h, "/v1/requests", body, nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("code = %d", rec.Code)
	}
	if got := promtest.ToFloat64(e.records.WithLabelValues("requests", "rejected")); got != 1 {
		t.Errorf("rejected total = %v", got)
	}
	if len(stats.byApp) != 0 {
		t.Errorf("stats = %+v", stats.byApp)
	}
}
