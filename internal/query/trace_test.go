package query

import (
	"testing"
	"time"
)

func TestCapTrace(t *testing.T) {
	rows, cut := capTrace([]int{1, 2, 3}, 3)
	if len(rows) != 3 || cut {
		t.Errorf("at the limit: %v %v", rows, cut)
	}
	rows, cut = capTrace([]int{1, 2, 3, 4}, 3)
	if len(rows) != 3 || rows[2] != 3 || !cut {
		t.Errorf("over the limit: %v %v", rows, cut)
	}
	if limits := [2]int{maxTraceSpans, maxTraceLogs}; limits != [2]int{10000, 2000} {
		t.Errorf("limits = %v", limits)
	}
}

func TestZipSpanEvents(t *testing.T) {
	at := time.Date(2026, 11, 16, 10, 0, 0, 7, time.FixedZone("x", 3600))
	got := zipSpanEvents(
		[]time.Time{at, at.Add(time.Millisecond)},
		[]string{"exception", "retry"},
		[]map[string]string{{"exception.type": "ValueError"}, nil},
	)
	if len(got) != 2 || got[0].Name != "exception" || !got[0].Time.Equal(at) || got[0].Time.Location() != time.UTC ||
		got[0].Attributes["exception.type"] != "ValueError" || got[1].Name != "retry" || got[1].Attributes == nil {
		t.Fatalf("events = %+v", got)
	}
	// Ragged arrays keep only complete events; none yields an empty slice.
	if got := zipSpanEvents([]time.Time{at}, []string{"a", "b"}, nil); got == nil || len(got) != 0 {
		t.Errorf("ragged = %#v", got)
	}
}

func TestZipSpanLinks(t *testing.T) {
	got := zipSpanLinks([]string{"4bf92f3577b34da6a3ce929d0e0e4736"}, []string{"00f067aa0ba902b7"})
	if len(got) != 1 || got[0] != (spanLinkOut{TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", SpanID: "00f067aa0ba902b7"}) {
		t.Fatalf("links = %+v", got)
	}
	if got := zipSpanLinks(nil, nil); got == nil || len(got) != 0 {
		t.Errorf("no links = %#v", got)
	}
}
