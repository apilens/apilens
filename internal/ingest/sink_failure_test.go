package ingest

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/apilens/apilens/internal/pipeline"
)

// TestSinkFailureAnswers503AndCountsInHealth (#922): when the sink cannot
// store a batch (insert retries exhausted, queue full) the caller gets a
// retryable 503, nothing is counted as accepted, and ingest health counts
// the records as rejected for storage_unavailable.
func TestSinkFailureAnswers503AndCountsInHealth(t *testing.T) {
	bodies := map[string]string{
		"/v1/requests": `{"requests":[
			{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/a"},
			{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/b"}]}`,
		"/v1/traces": `{"spans":[
			{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","name":"a"},
			{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b8","name":"b"}]}`,
	}
	sinkErrs := map[string]error{
		"insert failed": fmt.Errorf("pipeline: store api_requests: %w", errors.New("clickhouse down")),
		"overloaded":    pipeline.ErrOverloaded,
	}
	for path, body := range bodies {
		for name, sinkErr := range sinkErrs {
			t.Run(path+" "+name, func(t *testing.T) {
				stats := &memUsage{}
				sink := &fakeSink{err: sinkErr}
				rec := post(t, newPartialEdge(t, sink, stats), path, body, nil)
				if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
					t.Fatalf("got %d (Retry-After %q) %s, want a retryable 503", rec.Code, rec.Header().Get("Retry-After"), rec.Body)
				}
				if len(sink.requests)+len(sink.spans) != 0 {
					t.Fatalf("rows reported stored: %d requests, %d spans", len(sink.requests), len(sink.spans))
				}
				if c := stats.byApp[testApp]; c.Accepted != 0 || c.Rejected != 2 {
					t.Fatalf("health = %+v, want 0 accepted 2 rejected", c)
				}
				if r := stats.reasons[testApp]; r[ReasonStorageUnavailable] != 2 || len(r) != 1 {
					t.Fatalf("reasons = %v, want 2 %s", r, ReasonStorageUnavailable)
				}
			})
		}
	}
}
