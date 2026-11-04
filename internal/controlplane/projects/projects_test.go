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

func TestRoles(t *testing.T) {
	for role, want := range map[string][2]bool{
		"owner":  {true, true},
		"admin":  {true, true},
		"member": {true, false},
		"viewer": {false, false},
		"":       {false, false},
	} {
		if CanWrite(role) != want[0] || CanDelete(role) != want[1] {
			t.Errorf("%q: write=%v delete=%v", role, CanWrite(role), CanDelete(role))
		}
	}
}
