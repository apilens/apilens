//go:build integration

package query_test

import (
	"net/http"
	"slices"
	"testing"
)

// TestTrafficLatency checks the project-wide response-time report of the
// Performance dashboard over the endpoint-performance seed: every endpoint
// of the project, scoped by environment, never another project's rows.
func TestTrafficLatency(t *testing.T) {
	get, mine, theirs := seedEndpointPerformance(t)
	fetch := func(key, query string) endpointLatency {
		t.Helper()
		var out endpointLatency
		if code := get(key, "/api/v1/traffic/latency?"+query, &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", query, code)
		}
		if len(out.Histogram) != 14 || out.Histogram[0].FromMs != 0 || out.Histogram[13].ToMs != nil {
			t.Fatalf("%s: histogram edges %+v", query, out.Histogram)
		}
		var n uint64
		for _, p := range out.Points {
			n += p.Requests
		}
		if n != out.Summary.Requests {
			t.Fatalf("%s: points add up to %d, want %d", query, n, out.Summary.Requests)
		}
		return out
	}

	// Both endpoints (GET and POST) of both environments.
	out := fetch(mine.ReadKey, "range=1h")
	s := out.Summary
	if out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("all: bucket=%d points=%d", out.BucketSeconds, len(out.Points))
	}
	if s.Requests != 7 || s.MaxMs != 12000 {
		t.Fatalf("all: summary %+v", s)
	}
	if !(s.P50Ms > 0 && s.P50Ms <= s.P75Ms && s.P75Ms <= s.P95Ms && s.P95Ms <= 12000) {
		t.Fatalf("all: percentiles not ordered %+v", s)
	}
	//                          <1 <2 <5 <10 <20 <50 <100 <200 <500 <1s <2s <5s <10s +inf
	want := []uint64{1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1}
	if got := latencyCounts(out); !slices.Equal(got, want) {
		t.Fatalf("all: histogram %v, want %v", got, want)
	}

	if out := fetch(mine.ReadKey, "range=1h&env=staging"); out.Summary.Requests != 1 || out.Summary.P50Ms != 30 ||
		!slices.Equal(latencyCounts(out), []uint64{0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0}) {
		t.Fatalf("staging: %+v %v", out.Summary, latencyCounts(out))
	}
	if out := fetch(mine.ReadKey, "range=7d"); out.Summary.Requests != 7 || out.BucketSeconds != 3600 {
		t.Fatalf("7d: %+v", out.Summary)
	}
	if s := fetch(theirs.ReadKey, "range=1h").Summary; s.Requests != 1 || s.MaxMs != 999 {
		t.Fatalf("other project: %+v", s)
	}
	if code := get(mine.ReadKey, "/api/v1/traffic/latency?range=30d", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("range=30d = %d, want 422", code)
	}
	if code := get(mine.APIKey, "/api/v1/traffic/latency?range=1h", nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}
