package projects

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEnvironmentInUse(t *testing.T) {
	if (Environment{}).InUse() {
		t.Fatal("an environment without data or references is not in use")
	}
	for _, e := range []Environment{{HasData: true}, {APIKeys: 1}, {HealthChecks: 2}} {
		if !e.InUse() {
			t.Errorf("%+v should be in use", e)
		}
	}
}

func TestEnvironmentUpdatesValidateFirst(t *testing.T) {
	// Invalid input is refused before the database is touched (no pool).
	s := New(nil)
	hex := "#ff0000"
	if _, err := s.UpdateEnvironment(t.Context(), uuid.Nil, uuid.Nil, "prod", EnvironmentUpdate{Color: &hex}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("hex colour: %v", err)
	}
	for _, order := range [][]string{{"a", "a"}, {"bad name"}} {
		if _, err := s.ReorderEnvironments(t.Context(), uuid.Nil, uuid.Nil, order); !errors.Is(err, ErrInvalid) {
			t.Fatalf("order %v: %v", order, err)
		}
	}
}

func TestDataRetention(t *testing.T) {
	if got := New(nil).dataRetention(); got != DefaultDataRetention {
		t.Fatalf("default = %v", got)
	}
	if got := New(nil).WithDataRetention(time.Hour).dataRetention(); got != time.Hour {
		t.Fatalf("set = %v", got)
	}
}

func TestPositionsDense(t *testing.T) {
	if !positionsDense([]Environment{{Position: 0}, {Position: 1}}) || positionsDense([]Environment{{Position: 0}, {Position: 0}}) {
		t.Fatal("positionsDense")
	}
}
