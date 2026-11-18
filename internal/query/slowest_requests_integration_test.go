//go:build integration

package query_test

import (
	"net/http"
	"slices"
	"testing"
)

// TestSlowestRequests checks GET /api/v1/requests/slowest (#1001) over the
// endpoint-performance seed: the project's raw requests, slowest first,
// narrowed by environment and capped by limit, never another project's.
func TestSlowestRequests(t *testing.T) {
	get, mine, theirs := seedEndpointPerformance(t)
	type row struct {
		ID             string  `json:"id"`
		Method         string  `json:"method"`
		Environment    string  `json:"environment"`
		ResponseTimeMs float64 `json:"response_time_ms"`
	}
	fetch := func(key, query string) []row {
		t.Helper()
		var out struct {
			Requests []row `json:"requests"`
		}
		if code := get(key, "/api/v1/requests/slowest?"+query, &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", query, code)
		}
		return out.Requests
	}
	times := func(rows []row) []float64 {
		out := make([]float64, 0, len(rows))
		for _, r := range rows {
			if r.ID == "" {
				t.Fatalf("row without an id: %+v", r)
			}
			out = append(out, r.ResponseTimeMs)
		}
		return out
	}

	if got := times(fetch(mine.ReadKey, "range=1h")); !slices.Equal(got, []float64{12000, 150, 30, 7, 3, 1.5, 0.5}) {
		t.Fatalf("all: %v", got)
	}
	if got := times(fetch(mine.ReadKey, "range=1h&limit=2")); !slices.Equal(got, []float64{12000, 150}) {
		t.Fatalf("limit=2: %v", got)
	}
	if got := fetch(mine.ReadKey, "range=1h&env=staging"); len(got) != 1 || got[0].ResponseTimeMs != 30 || got[0].Environment != "staging" {
		t.Fatalf("staging: %+v", got)
	}
	if got := times(fetch(theirs.ReadKey, "range=1h")); !slices.Equal(got, []float64{999}) {
		t.Fatalf("theirs: %v", got)
	}
	if code := get(mine.ReadKey, "/api/v1/requests/slowest?range=1h&limit=51", nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("limit=51: %d, want 422", code)
	}
}
