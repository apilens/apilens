package query

import (
	"testing"
	"time"
)

func TestTimelineStep(t *testing.T) {
	for span, want := range map[time.Duration]time.Duration{
		30 * time.Second:     time.Second,
		100 * time.Second:    time.Second,
		101 * time.Second:    2 * time.Second,
		10 * time.Minute:     10 * time.Second,
		time.Hour:            time.Minute,
		6 * time.Hour:        5 * time.Minute,
		24 * time.Hour:       15 * time.Minute,
		7 * 24 * time.Hour:   2 * time.Hour,
		400 * 24 * time.Hour: 24 * time.Hour,
	} {
		if got := timelineStep(span); got != want {
			t.Errorf("timelineStep(%s) = %s, want %s", span, got, want)
		}
	}
}

func TestTimelineBuckets(t *testing.T) {
	from := time.Date(2026, 11, 5, 10, 0, 30, 0, time.UTC)
	to := time.Date(2026, 11, 5, 10, 3, 0, 0, time.UTC)
	got := timelineBuckets(from, to, time.Minute)
	if len(got) != 3 || !got[0].Equal(from.Truncate(time.Minute)) || !got[2].Equal(time.Date(2026, 11, 5, 10, 2, 0, 0, time.UTC)) {
		t.Fatalf("buckets = %v", got)
	}
	if got := timelineBuckets(to, to, time.Minute); len(got) != 0 {
		t.Fatalf("empty window gave %v", got)
	}
}

func TestNarrowWindow(t *testing.T) {
	w := window{from: time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC), to: time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)}
	at := func(m int) time.Time { return w.from.Add(time.Duration(m) * time.Minute) }
	for _, c := range []struct {
		name           string
		from, to       time.Time
		wantLo, wantHi time.Time
	}{
		{"none", time.Time{}, time.Time{}, w.from, w.to},
		{"inside", at(10), at(20), at(10), at(20)},
		{"from only", at(30), time.Time{}, at(30), w.to},
		{"to only", time.Time{}, at(5), w.from, at(5)},
		{"clamped", at(-30), at(90), w.from, w.to},
		{"left behind", at(-30), at(-10), w.from, w.from},
	} {
		lo, hi, err := narrowWindow(w, c.from, c.to)
		if err != nil || !lo.Equal(c.wantLo) || !hi.Equal(c.wantHi) {
			t.Errorf("%s: [%s, %s) %v", c.name, lo, hi, err)
		}
	}
	if _, _, err := narrowWindow(w, at(20), at(20)); err == nil {
		t.Fatal("from == to accepted")
	}
}

func TestTimelineFilterCopiesEveryFilter(t *testing.T) {
	in := &requestTimelineInput{Method: "get", Status: "5xx", LatencyMax: 0, hasLatencyMax: true, Sampled: "false"}
	clauses, _, err := requestFilter(in.filter(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(clauses) != 4 {
		t.Fatalf("clauses = %q", clauses)
	}
}
