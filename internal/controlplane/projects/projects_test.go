package projects

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestValidEnvironment(t *testing.T) {
	for _, s := range []string{"production", "Staging", "eu-west-1", "v1.2", "qa_2", strings.Repeat("a", 64)} {
		if !ValidEnvironment(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []string{"", "-prod", ".prod", "prod env", "prod/eu", strings.Repeat("a", 65)} {
		if ValidEnvironment(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestEnvironments(t *testing.T) {
	got, err := environments(nil)
	if err != nil || !slices.Equal(got, DefaultEnvironments) {
		t.Fatalf("default = %v, %v", got, err)
	}
	got[0] = "changed"
	if DefaultEnvironments[0] != "production" {
		t.Fatal("default environments were aliased")
	}
	if got, err := environments([]string{"staging", "production", "staging"}); err != nil || !slices.Equal(got, []string{"staging", "production"}) {
		t.Fatalf("dedup = %v, %v", got, err)
	}
	if _, err := environments([]string{"ok", "not ok"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid = %v", err)
	}
	many := make([]string, MaxEnvironments+1)
	for i := range many {
		many[i] = "e" + strings.Repeat("x", i)
	}
	if _, err := environments(many); !errors.Is(err, ErrTooManyEnvironments) {
		t.Fatalf("too many = %v", err)
	}
}

func TestCreatorRole(t *testing.T) {
	for orgRole, want := range map[string]string{"owner": RoleAdmin, "admin": RoleAdmin, "member": RoleEditor} {
		if got := creatorRole(orgRole); got != want {
			t.Errorf("creatorRole(%q) = %q, want %q", orgRole, got, want)
		}
	}
}
