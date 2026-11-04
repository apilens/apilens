package orgs

import (
	"strings"
	"testing"
)

func TestReservedSlugsAreValid(t *testing.T) {
	for _, s := range []string{"apilens", "admin", "api", "www", "app", "docs", "status", "slug-available"} {
		if !Reserved(s) {
			t.Errorf("%q is not reserved", s)
		}
	}
	for _, s := range reserved {
		if !ValidSlug(s) {
			t.Errorf("reserved %q does not match the slug pattern", s)
		}
	}
	if Reserved("acme") {
		t.Error("acme is reserved")
	}
}

func TestValidSlug(t *testing.T) {
	for _, s := range []string{"a", "acme", "acme-2", "0x", strings.Repeat("a", 63)} {
		if !ValidSlug(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []string{"", "-acme", "Acme", "acme_co", "ac me", strings.Repeat("a", 64)} {
		if ValidSlug(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestCandidatesAreValid(t *testing.T) {
	for _, slug := range []string{"acme", strings.Repeat("a", 63), strings.Repeat("a", 60) + "---", "a-"} {
		cands := append(numbered(slug), randomized(slug)...)
		for _, c := range cands {
			if !ValidSlug(c) || strings.Contains(c, "--") {
				t.Errorf("%q: candidate %q is not a valid slug", slug, c)
			}
		}
	}
	if got := numbered("acme"); got[0] != "acme-2" || got[len(got)-1] != "acme-9" {
		t.Fatalf("numbered = %v", got)
	}
}
