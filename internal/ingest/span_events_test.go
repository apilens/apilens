package ingest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/apilens/apilens/internal/pipeline"
)

const (
	testTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	testSpanID  = "00f067aa0ba902b7"
)

func spansBody(t *testing.T, extra map[string]any) string {
	t.Helper()
	span := map[string]any{
		"app_id": "storefront", "timestamp": "2026-10-22T11:00:00Z", "trace_id": testTraceID,
		"span_id": testSpanID, "name": "POST /charge", "kind": "server", "status": "error", "duration_ms": 12,
	}
	for k, v := range extra {
		span[k] = v
	}
	b, err := json.Marshal(map[string]any{"spans": []any{span}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSpanStatusMessageEventsLinksStored(t *testing.T) {
	sink := &fakeSink{}
	e, h := newCapsEdge(t, nil, sink)
	body := spansBody(t, map[string]any{
		"status_message": "  ValueError: card declined  ",
		"events": []any{
			map[string]any{"timestamp": "2026-10-22T11:00:00.005Z", "name": "exception", "attributes": map[string]any{
				"exception.type": "ValueError", "exception.message": "card declined",
				"exception.stacktrace": "Traceback ...", "exception.escaped": true, "nested": map[string]any{"a": 1},
			}},
			map[string]any{"name": "retry"},
		},
		"links": []any{
			map[string]any{"trace_id": strings.ToUpper("5bf92f3577b34da6a3ce929d0e0e4736"), "span_id": "10f067aa0ba902b7"},
			map[string]any{"trace_id": "not-hex", "span_id": "10f067aa0ba902b7"},
		},
	})
	if rec := post(t, h, "/v1/traces", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	s := sink.spans[0]
	if s.StatusMessage != "ValueError: card declined" {
		t.Errorf("status_message = %q", s.StatusMessage)
	}
	if len(s.Events) != 2 {
		t.Fatalf("events = %+v", s.Events)
	}
	ex := s.Events[0]
	if ex.Name != "exception" || !ex.Time.Equal(time.Date(2026, 10, 22, 11, 0, 0, 5_000_000, time.UTC)) {
		t.Errorf("exception event = %+v", ex)
	}
	want := map[string]string{"exception.type": "ValueError", "exception.message": "card declined",
		"exception.stacktrace": "Traceback ...", "exception.escaped": "true"}
	if fmt.Sprint(ex.Attributes) != fmt.Sprint(want) {
		t.Errorf("exception attributes = %v, want %v", ex.Attributes, want)
	}
	// An event without a timestamp takes the span's start.
	if r := s.Events[1]; r.Name != "retry" || !r.Time.Equal(s.Timestamp) || r.Attributes != nil {
		t.Errorf("retry event = %+v", r)
	}
	// Ids are normalised; a link with a malformed id is dropped.
	if len(s.Links) != 1 || s.Links[0] != (pipeline.SpanLink{TraceID: "5bf92f3577b34da6a3ce929d0e0e4736", SpanID: "10f067aa0ba902b7"}) {
		t.Errorf("links = %+v", s.Links)
	}
	if c := truncatedCount(e, FieldSpanEvents); c != 0 {
		t.Errorf("nothing was over a cap, counted %v", c)
	}
}

// Spans from older SDKs carry none of the new fields.
func TestSpanWithoutEventsOrLinks(t *testing.T) {
	sink := &fakeSink{}
	_, h := newCapsEdge(t, nil, sink)
	if rec := post(t, h, "/v1/traces", spansBody(t, nil), nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if s := sink.spans[0]; s.StatusMessage != "" || s.Events != nil || s.Links != nil {
		t.Errorf("span row: %+v", s)
	}
}

func TestSpanEventCapsEnforced(t *testing.T) {
	sink := &fakeSink{}
	e, h := newCapsEdge(t, nil, sink)

	attrs := map[string]any{
		"exception.type":       "ValueError",
		"exception.stacktrace": "HEAD" + strings.Repeat("s", 100<<10) + "ROOT CAUSE",
		"long":                 strings.Repeat("v", 600),
	}
	for i := range 100 {
		attrs[fmt.Sprintf("k%03d", i)] = "x"
	}
	events := make([]any, 200)
	events[0] = map[string]any{"name": "exception", "attributes": attrs}
	for i := 1; i < len(events); i++ {
		events[i] = map[string]any{"name": fmt.Sprintf("e%d", i)}
	}
	links := make([]any, 200)
	for i := range links {
		links[i] = map[string]any{"trace_id": testTraceID, "span_id": fmt.Sprintf("%016x", i+1)}
	}
	body := spansBody(t, map[string]any{
		"status_message": strings.Repeat("m", maxSpanStatusMessageChars+10),
		"events":         events,
		"links":          links,
	})
	if rec := post(t, h, "/v1/traces", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	s := sink.spans[0]
	if len(s.Events) != maxSpanEvents {
		t.Errorf("events = %d, want %d", len(s.Events), maxSpanEvents)
	}
	if len(s.Links) != maxSpanLinks {
		t.Errorf("links = %d, want %d", len(s.Links), maxSpanLinks)
	}
	if n := utf8.RuneCountInString(s.StatusMessage); n != maxSpanStatusMessageChars {
		t.Errorf("status_message = %d chars", n)
	}
	got := s.Events[0].Attributes
	if len(got) != maxSpanEventAttributes {
		t.Errorf("event attributes = %d, want %d", len(got), maxSpanEventAttributes)
	}
	// exception.* attributes survive the attribute cap.
	if got["exception.type"] != "ValueError" {
		t.Errorf("exception.type dropped: %v", got["exception.type"])
	}
	if v := got["long"]; v != "" && utf8.RuneCountInString(v) != maxAttributeValueChars {
		t.Errorf("long value = %d chars, want %d", len(v), maxAttributeValueChars)
	}
	st := got["exception.stacktrace"]
	if utf8.RuneCountInString(st) > maxStacktraceChars || !strings.HasPrefix(st, "HEAD") || !strings.HasSuffix(st, "ROOT CAUSE") ||
		!strings.Contains(st, "chars truncated]…\n") {
		t.Errorf("stacktrace not head+tail capped: len %d", len(st))
	}
	if c := truncatedCount(e, FieldSpanEvents); c != 1 {
		t.Errorf("apilens_ingest_truncated_total{field=%q} = %v, want 1", FieldSpanEvents, c)
	}
}

func TestSpanEventValueCap(t *testing.T) {
	attrs, cut := spanEventAttributes(map[string]json.RawMessage{"long": json.RawMessage(`"` + strings.Repeat("é", 600) + `"`)})
	if !cut || utf8.RuneCountInString(attrs["long"]) != maxAttributeValueChars {
		t.Errorf("cut=%v len=%d", cut, utf8.RuneCountInString(attrs["long"]))
	}
}
