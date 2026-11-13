package ingest

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

// memUsage is an in-memory StatsStore that also keeps the usage breakdowns.
type memUsage struct {
	memStats
	reasons map[uuid.UUID]map[string]int64
	envs    map[uuid.UUID]map[string]int64
	bytes   map[uuid.UUID]int64
}

func (m *memUsage) AddUsage(_ context.Context, _ time.Time, projectID uuid.UUID, bytes int64, deltas map[uuid.UUID]Breakdown) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.reasons == nil {
		m.reasons, m.envs, m.bytes = map[uuid.UUID]map[string]int64{}, map[uuid.UUID]map[string]int64{}, map[uuid.UUID]int64{}
	}
	m.bytes[projectID] += bytes
	for id, b := range deltas {
		for r, n := range b.RejectedBy {
			if m.reasons[id] == nil {
				m.reasons[id] = map[string]int64{}
			}
			m.reasons[id][r] += n
		}
		for env, n := range b.Environments {
			if m.envs[id] == nil {
				m.envs[id] = map[string]int64{}
			}
			m.envs[id][env] += n
		}
	}
	return nil
}

func sumOf(m map[string]int64) (n int64) {
	for _, v := range m {
		n += v
	}
	return n
}

// TestUsageBreakdowns: the edge splits rejected records by reason and
// accepted records by environment, both summing to the per-app counters, and
// counts the bytes of admitted calls only.
func TestUsageBreakdowns(t *testing.T) {
	stats := &memUsage{}
	q := &fakeQuota{decision: QuotaDecision{Allowed: true}}
	_, h := newStatsEdge(t, stats, q)
	ts := "2026-10-22T11:59:00Z"

	reqs := jsonBody(t, "requests",
		map[string]any{"app_id": "storefront", "environment": "staging", "timestamp": ts, "method": "GET", "path": "/a", "status_code": 200},
		map[string]any{"app_id": "storefront", "timestamp": ts, "method": "GET", "path": "/b", "status_code": 200},
		map[string]any{"app_id": "billing", "environment": "staging", "timestamp": ts, "method": "GET", "path": "/c", "status_code": 200},
	)
	if rec := post(t, h, "/v1/requests", reqs, nil); rec.Code != http.StatusOK {
		t.Fatalf("requests: %d %s", rec.Code, rec.Body)
	}
	good := &tracepb.Span{TraceId: traceID, SpanId: spanID, Name: "GET /orders", StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 1}
	bad := &tracepb.Span{Name: "no ids", StartTimeUnixNano: startNs}
	if rec := otlpPost(t, h, "/otlp/v1/traces", &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{good, bad}}}},
	}}); rec.Code != http.StatusOK {
		t.Fatalf("otlp: %d", rec.Code)
	}
	admitted := stats.bytes[testProject]
	if admitted < int64(len(reqs)) {
		t.Fatalf("bytes = %d, want at least the requests body (%d)", admitted, len(reqs))
	}

	q.decision = QuotaDecision{Reason: ReasonBytesPerDay, RetryAfter: time.Second}
	if rec := post(t, h, "/v1/requests", reqs, nil); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("refused: %d", rec.Code)
	}
	if stats.bytes[testProject] != admitted {
		t.Errorf("bytes = %d after a refused call, want %d", stats.bytes[testProject], admitted)
	}

	if got := stats.reasons[testApp]; got[ReasonInvalid] != 1 || got[ReasonBytesPerDay] != 2 || len(got) != 2 {
		t.Errorf("storefront reasons = %v", got)
	}
	if got := stats.envs[testApp]; got["staging"] != 2 || got[defaultEnvironment] != 1 { // the OTLP span carries staging
		t.Errorf("storefront envs = %v", got)
	}
	for _, id := range []uuid.UUID{testApp, billingApp} {
		c := stats.byApp[id]
		if sumOf(stats.reasons[id]) != c.Rejected || sumOf(stats.envs[id]) != c.Accepted {
			t.Errorf("app %s: reasons %v envs %v do not sum to %+v", id, stats.reasons[id], stats.envs[id], c)
		}
	}
}
