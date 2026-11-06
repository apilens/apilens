package query

import (
	"testing"
	"time"
)

func TestRegressionWeighsErrorRateAndP95InSteps(t *testing.T) {
	side := func(req uint64, rate, p95 float64) sideStats {
		return sideStats{Requests: req, ErrorRate: rate, P95Ms: p95}
	}
	cases := []struct {
		name   string
		b, a   sideStats
		expect float64
	}{
		{"no traffic before", side(0, 0, 0), side(10, 0.5, 100), 0},
		{"no traffic after", side(10, 0.5, 100), side(0, 0, 0), 0},
		{"error rate up 1 pp is two steps", side(100, 0.01, 100), side(100, 0.02, 100), 2},
		{"p95 doubled is ten steps", side(100, 0, 100), side(100, 0, 200), 10},
		{"a 3 ms move is noise however relative", side(100, 0, 2), side(100, 0, 5), 0},
		{"better on both is negative", side(100, 0.05, 100), side(100, 0.04, 80), -2},
	}
	for _, c := range cases {
		got := regression(c.b, c.a)
		if d := got - c.expect; d > 1e-9 || d < -1e-9 {
			t.Errorf("%s: regression = %v, want %v", c.name, got, c.expect)
		}
	}
}

func TestSortDeployEndpointsPutsTheWorstFirstThenNewThenGone(t *testing.T) {
	ep := func(path, change string, b, a sideStats) deployEndpoint {
		return deployEndpoint{Method: "GET", Path: path, Change: change, Before: splitSide{sideStats: b}, After: splitSide{sideStats: a}}
	}
	es := []deployEndpoint{
		ep("/gone-small", "gone", sideStats{Requests: 2}, sideStats{}),
		ep("/flat", "compared", sideStats{Requests: 100, P95Ms: 50}, sideStats{Requests: 100, P95Ms: 50}),
		ep("/new", "new", sideStats{}, sideStats{Requests: 7}),
		ep("/slower", "compared", sideStats{Requests: 100, P95Ms: 50}, sideStats{Requests: 100, P95Ms: 150}),
		ep("/gone-big", "gone", sideStats{Requests: 40}, sideStats{}),
		ep("/erroring", "compared", sideStats{Requests: 100}, sideStats{Requests: 100, ErrorRate: 0.02}),
		ep("/faster", "compared", sideStats{Requests: 100, P95Ms: 150}, sideStats{Requests: 100, P95Ms: 50}),
	}
	sortDeployEndpoints(es)
	want := []string{"/slower", "/erroring", "/flat", "/faster", "/new", "/gone-big", "/gone-small"}
	for i, p := range want {
		if es[i].Path != p {
			t.Fatalf("order = %v, want %v", paths(es), want)
		}
	}
}

func paths(es []deployEndpoint) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.Path
	}
	return out
}

func TestFillMinutesZeroFillsEveryMinute(t *testing.T) {
	from := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	got := map[int64]deployPoint{from.Add(2 * time.Minute).Unix(): {Requests: 5, P95Ms: 12}}
	pts := fillMinutes(from, from.Add(4*time.Minute), got)
	if len(pts) != 4 {
		t.Fatalf("points = %d", len(pts))
	}
	for i, p := range pts {
		if !p.TS.Equal(from.Add(time.Duration(i) * time.Minute)) {
			t.Errorf("point %d at %v", i, p.TS)
		}
	}
	if pts[2].Requests != 5 || pts[2].P95Ms != 12 || pts[1].Requests != 0 {
		t.Errorf("points = %+v", pts)
	}
	if n := len(fillMinutes(from, from, nil)); n != 0 {
		t.Errorf("an empty window has %d points", n)
	}
}
