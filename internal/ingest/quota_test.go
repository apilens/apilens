package ingest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/gzip"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/protobuf/proto"

	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/apilens/apilens/internal/platform/config"
)

type quotaCall struct {
	project        uuid.UUID
	records, bytes int64
}

type fakeQuota struct {
	mu       sync.Mutex
	calls    []quotaCall
	decision QuotaDecision
	err      error
}

func (q *fakeQuota) Admit(_ context.Context, project uuid.UUID, records, bytes int64) (QuotaDecision, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.calls = append(q.calls, quotaCall{project, records, bytes})
	return q.decision, q.err
}

func newQuotaEdge(t *testing.T, q Quota, sink *fakeSink) (*Edge, http.Handler) {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil).WithQuota(q)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return e, mux
}

func TestQuotaChargesRecordsAndDecompressedBytes(t *testing.T) {
	q := &fakeQuota{decision: QuotaDecision{Allowed: true}}
	sink := &fakeSink{}
	_, h := newQuotaEdge(t, q, sink)

	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write([]byte(validRequest))
	_ = zw.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/requests", &gz)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-API-Key", testKey)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || len(sink.requests) != 1 {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	want := quotaCall{testProject, 1, int64(len(validRequest))}
	if len(q.calls) != 1 || q.calls[0] != want {
		t.Fatalf("quota calls = %+v, want [%+v]", q.calls, want)
	}
}

func TestQuotaExceededIs429WithRetryAfter(t *testing.T) {
	q := &fakeQuota{decision: QuotaDecision{Reason: ReasonRecordsPerMinute, RetryAfter: 1500 * time.Millisecond}}
	sink := &fakeSink{}
	e, h := newQuotaEdge(t, q, sink)

	rec := post(t, h, "/v1/requests", validRequest, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Errorf("Retry-After = %q, want 2 (rounded up)", got)
	}
	if len(sink.requests) != 0 {
		t.Errorf("rejected batch was stored: %+v", sink.requests)
	}
	if got := promtest.ToFloat64(e.rejected.WithLabelValues(ReasonRecordsPerMinute)); got != 1 {
		t.Errorf("apilens_ingest_rejected_total{reason=records_per_minute} = %v, want 1", got)
	}

	// Every record signal is limited, and a sub-second wait still says 1.
	q.decision = QuotaDecision{Reason: ReasonBytesPerDay, RetryAfter: time.Millisecond}
	for path, body := range map[string]string{
		"/v1/logs":    `{"logs":[{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","level":"INFO","message":"hi"}]}`,
		"/v1/traces":  `{"spans":[{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","name":"x"}]}`,
		"/v1/deploys": `{"deploys":[{"release":"v1"}]}`,
	} {
		rec := post(t, h, path, body, nil)
		if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "1" {
			t.Errorf("%s: got %d Retry-After=%q %s", path, rec.Code, rec.Header().Get("Retry-After"), rec.Body)
		}
	}
	if got := promtest.ToFloat64(e.rejected.WithLabelValues(ReasonBytesPerDay)); got != 3 {
		t.Errorf("apilens_ingest_rejected_total{reason=bytes_per_day} = %v, want 3", got)
	}
}

func TestQuotaOTLPIsResourceExhausted(t *testing.T) {
	q := &fakeQuota{decision: QuotaDecision{Reason: ReasonRecordsPerMinute, RetryAfter: 30 * time.Second}}
	sink := &fakeSink{}
	_, h := newQuotaEdge(t, q, sink)
	span := &tracepb.Span{TraceId: traceID, SpanId: spanID, Name: "GET /", StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 1}
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span, span}}}},
	}}
	rec := otlpPost(t, h, "/otlp/v1/traces", req)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "30" {
		t.Fatalf("got %d Retry-After=%q", rec.Code, rec.Header().Get("Retry-After"))
	}
	var st status.Status
	if err := proto.Unmarshal(rec.Body.Bytes(), &st); err != nil || st.GetCode() != 8 {
		t.Fatalf("status = %+v (%v), want RESOURCE_EXHAUSTED", &st, err)
	}
	if len(q.calls) != 1 || q.calls[0].records != 2 || q.calls[0].bytes <= 0 {
		t.Errorf("quota calls = %+v, want 2 spans and the body size", q.calls)
	}
	if len(sink.spans) != 0 {
		t.Errorf("rejected export was stored")
	}
}

func TestQuotaFailsOpen(t *testing.T) {
	q := &fakeQuota{err: errors.New("valkey down")}
	sink := &fakeSink{}
	_, h := newQuotaEdge(t, q, sink)
	if rec := post(t, h, "/v1/requests", validRequest, nil); rec.Code != http.StatusOK || len(sink.requests) != 1 {
		t.Fatalf("got %d %s, want the batch admitted while the quota backend is down", rec.Code, rec.Body)
	}
}

func TestQuotaNotChargedForRejectedAuth(t *testing.T) {
	q := &fakeQuota{decision: QuotaDecision{Allowed: true}}
	_, h := newQuotaEdge(t, q, &fakeSink{})
	if rec := post(t, h, "/v1/requests", validRequest, map[string]string{"X-API-Key": "nope"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d", rec.Code)
	}
	if rec := post(t, h, "/v1/requests", `{"requests":[]}`, nil); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d", rec.Code)
	}
	if len(q.calls) != 0 {
		t.Fatalf("quota charged for refused requests: %+v", q.calls)
	}
}

func TestValkeyQuotaWithoutLimitsAdmits(t *testing.T) {
	d, err := NewValkeyQuota(nil, config.QuotaConfig{}).Admit(context.Background(), testProject, 1, 1)
	if err != nil || !d.Allowed {
		t.Fatalf("Admit = %+v, %v", d, err)
	}
}
