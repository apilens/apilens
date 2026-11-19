package query

import (
	"slices"
	"strings"
	"testing"
)

// TestFacetQueryPages checks a facet page reads one value past its limit
// (for has_more) from its offset, both clamped.
func TestFacetQueryPages(t *testing.T) {
	for _, c := range []struct {
		name                  string
		limit, offset         int
		wantLimit, wantOffset int
	}{
		{"first page", 8, 0, 9, 0},
		{"second page", 8, 8, 9, 8},
		{"limit clamped", 500, 0, maxFacetValues + 1, 0},
		{"limit at least one", 0, 0, 2, 0},
		{"offset clamped", 8, 99999, 9, maxFacetOffset},
		{"negative offset", 8, -3, 9, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			q, args, err := facetQuery("status", "", c.limit, c.offset, []string{"project_id = ?"}, []any{"p"})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(q, "ORDER BY n DESC, v LIMIT ? OFFSET ?") {
				t.Fatalf("query %q", q)
			}
			if want := []any{"p", c.wantLimit, c.wantOffset}; !slices.Equal(args, want) {
				t.Fatalf("args %v, want %v", args, want)
			}
		})
	}
}
