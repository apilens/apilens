package ingest

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/apilens/apilens/internal/pipeline"
)

// Caps on the events, links and status message of a JSON span (/v1/traces).
const (
	maxSpanEvents             = 128
	maxSpanEventAttributes    = 64
	maxSpanLinks              = 128
	maxSpanStatusMessageChars = maxLogMessageChars
	// maxStacktraceChars caps the exception.stacktrace event attribute; the
	// head and the tail are kept (D4), so the raised exception and the root
	// cause both survive.
	maxStacktraceChars = 64 << 10
	stacktraceKey      = "exception.stacktrace"
)

// FieldSpanEvents is the truncated-field label of a span whose events, event
// attributes or links were cut to the caps above.
const FieldSpanEvents = "span_events"

type spanEventRecord struct {
	Timestamp  flexTime                   `json:"timestamp"`
	Name       string                     `json:"name"`
	Attributes map[string]json.RawMessage `json:"attributes"`
}

type spanLinkRecord struct {
	TraceID string `json:"trace_id"`
	SpanID  string `json:"span_id"`
}

// spanEvents normalises span events: at most maxSpanEvents, each with at most
// maxSpanEventAttributes attributes of maxAttributeValueChars, except
// exception.stacktrace (maxStacktraceChars, head+tail). An event without a
// timestamp takes the span's start. It reports whether anything was cut.
func spanEvents(in []spanEventRecord, start time.Time) ([]pipeline.SpanEventRow, bool) {
	if len(in) == 0 {
		return nil, false
	}
	cut := len(in) > maxSpanEvents
	in = in[:min(len(in), maxSpanEvents)]
	out := make([]pipeline.SpanEventRow, len(in))
	for i, ev := range in {
		ts := ev.Timestamp.Time
		if ts.IsZero() {
			ts = start
		}
		attrs, attrsCut := spanEventAttributes(ev.Attributes)
		cut = cut || attrsCut
		out[i] = pipeline.SpanEventRow{Time: ts.UTC(), Name: short(ev.Name), Attributes: attrs}
	}
	return out, cut
}

// spanEventAttributes is attributes with the event caps. Nested objects and
// arrays are dropped, as for span attributes.
func spanEventAttributes(in map[string]json.RawMessage) (map[string]string, bool) {
	if len(in) == 0 {
		return nil, false
	}
	// Over the cap, exception.* attributes win, then keys in order, so the
	// kept set does not depend on map iteration.
	keys := slices.Collect(maps.Keys(in))
	slices.SortFunc(keys, func(a, b string) int {
		if ea, eb := strings.HasPrefix(a, "exception."), strings.HasPrefix(b, "exception."); ea != eb {
			if ea {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	})
	out := make(map[string]string, min(len(in), maxSpanEventAttributes))
	cut := false
	for _, k := range keys {
		raw := in[k]
		key := truncate(strings.TrimSpace(k), maxAttributeKeyChars)
		if key == "" {
			continue
		}
		if t := firstNonSpace(raw); t == '{' || t == '[' {
			continue
		}
		if len(out) >= maxSpanEventAttributes {
			cut = true
			break
		}
		v, limit := rawToString(raw), maxAttributeValueChars
		capped := truncate(v, limit)
		if key == stacktraceKey {
			limit = maxStacktraceChars
			capped = truncateHeadTail(v, limit)
		}
		cut = cut || utf8.RuneCountInString(v) > limit
		out[key] = capped
	}
	return out, cut
}

// spanLinks keeps the links with well-formed W3C ids, at most maxSpanLinks.
func spanLinks(in []spanLinkRecord) ([]pipeline.SpanLink, bool) {
	if len(in) == 0 {
		return nil, false
	}
	out := make([]pipeline.SpanLink, 0, min(len(in), maxSpanLinks))
	for _, l := range in {
		traceID, spanID := hexID(l.TraceID, traceIDHexLen), hexID(l.SpanID, spanIDHexLen)
		if traceID == "" || spanID == "" {
			continue
		}
		if len(out) >= maxSpanLinks {
			return out, true
		}
		out = append(out, pipeline.SpanLink{TraceID: traceID, SpanID: spanID})
	}
	return out, false
}
