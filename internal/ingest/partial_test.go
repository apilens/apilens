package ingest

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/platform/config"
)

func newPartialEdge(t *testing.T, sink *fakeSink, stats StatsStore) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry()).
		WithStats(stats)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

type partialAnswer struct {
	Accepted int           `json:"accepted"`
	Invalid  int           `json:"invalid"`
	Errors   []recordError `json:"errors"`
}

func decodeAnswer(t *testing.T, body string) partialAnswer {
	t.Helper()
	var out partialAnswer
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("answer %q: %v", body, err)
	}
	return out
}

// TestPartialAcceptRequests: the valid records of a mixed batch are stored,
// the answer names every bad one by index, and ingest health counts them.
func TestPartialAcceptRequests(t *testing.T) {
	sink, stats := &fakeSink{}, &memUsage{}
	h := newPartialEdge(t, sink, stats)
	body := `{"requests":[
		{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/a"},
		{"app_id":"storefront","timestamp":"yesterday","method":"GET","path":"/b"},
		{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","path":"/c"},
		5,
		{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","method":"POST","path":"/d"}
	]}`
	rec := post(t, h, "/v1/requests", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	got := decodeAnswer(t, rec.Body.String())
	if got.Accepted != 2 || got.Invalid != 3 || len(got.Errors) != 3 {
		t.Fatalf("answer = %+v", got)
	}
	for i, want := range []int{1, 2, 3} {
		if got.Errors[i].Index != want || !strings.HasPrefix(got.Errors[i].Reason, "requests[") {
			t.Errorf("errors[%d] = %+v, want index %d", i, got.Errors[i], want)
		}
	}
	if !strings.Contains(got.Errors[1].Reason, "method and path are required") {
		t.Errorf("errors[1].reason = %q", got.Errors[1].Reason)
	}
	if len(sink.requests) != 2 || sink.requests[0].Path != "/a" || sink.requests[1].Path != "/d" {
		t.Fatalf("stored %+v", sink.requests)
	}
	// The non-object record names no app, so health counts the other two.
	if c := stats.byApp[testApp]; c.Accepted != 2 || c.Rejected != 2 {
		t.Errorf("health = %+v, want 2 accepted 2 rejected", c)
	}
	if r := stats.reasons[testApp]; r[ReasonInvalid] != 2 || len(r) != 1 {
		t.Errorf("reasons = %v", r)
	}
}

// TestPartialAcceptAllInvalid: a batch with no valid record is still a 200
// that lists the rejects, and nothing is stored.
func TestPartialAcceptAllInvalid(t *testing.T) {
	sink := &fakeSink{}
	recs := make([]string, 25)
	for i := range recs {
		recs[i] = `{"app_id":"storefront","timestamp":"2027-01-01T00:00:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}`
	}
	rec := post(t, newPartialEdge(t, sink, &memUsage{}), "/v1/traces", `{"spans":[`+strings.Join(recs, ",")+`]}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	got := decodeAnswer(t, rec.Body.String())
	if got.Accepted != 0 || got.Invalid != 25 || len(got.Errors) != maxRecordErrors {
		t.Fatalf("answer: accepted %d invalid %d errors %d", got.Accepted, got.Invalid, len(got.Errors))
	}
	if got.Errors[maxRecordErrors-1].Index != maxRecordErrors-1 {
		t.Errorf("last listed error = %+v", got.Errors[maxRecordErrors-1])
	}
	if len(sink.spans) != 0 {
		t.Errorf("stored %d spans", len(sink.spans))
	}
}

// TestPartialAcceptLogsAndSpans: logs and spans keep their good records too.
func TestPartialAcceptLogsAndSpans(t *testing.T) {
	sink := &fakeSink{}
	h := newPartialEdge(t, sink, &memUsage{})
	logs := `{"logs":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","level":"ERROR","message":"boom"},
		{"app_id":"storefront","timestamp":{"bad":true},"message":"x"}]}`
	if rec := post(t, h, "/v1/logs", logs, nil); rec.Code != http.StatusOK || decodeAnswer(t, rec.Body.String()).Accepted != 1 {
		t.Fatalf("logs: %d %s", rec.Code, rec.Body)
	}
	spans := `{"spans":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","trace_id":"xyz","span_id":"00f067aa0ba902b7"},
		{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}]}`
	rec := post(t, h, "/v1/traces", spans, nil)
	if got := decodeAnswer(t, rec.Body.String()); rec.Code != http.StatusOK || got.Accepted != 1 || got.Invalid != 1 || got.Errors[0].Index != 0 {
		t.Fatalf("spans: %d %s", rec.Code, rec.Body)
	}
	if len(sink.logs) != 1 || len(sink.spans) != 1 {
		t.Fatalf("stored %d logs %d spans", len(sink.logs), len(sink.spans))
	}
}

// TestPartialAcceptUnparsableBody: a body that does not parse is still 400.
func TestPartialAcceptUnparsableBody(t *testing.T) {
	for _, path := range []string{"/v1/requests", "/v1/logs", "/v1/traces", "/v1/deploys"} {
		rec := post(t, newPartialEdge(t, &fakeSink{}, nil), path, `{"x":[`, nil)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_body") {
			t.Errorf("%s: got %d %s", path, rec.Code, rec.Body)
		}
	}
}
