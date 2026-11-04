package app

import (
	"io"
	"log/slog"
	"slices"
	"testing"

	"github.com/apilens/apilens/internal/platform/config"
)

func newTestApp() *App {
	return New(&config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestTargets(t *testing.T) {
	got := newTestApp().Targets()
	want := []string{TargetAll, TargetAPI, TargetEdge, TargetIdentity, TargetQuery}
	if !slices.Equal(got, want) {
		t.Fatalf("Targets() = %v, want %v", got, want)
	}
	for _, target := range got {
		if _, planned := PlannedTargets[target]; planned {
			t.Errorf("%q is both implemented and planned", target)
		}
	}
}

func TestResolve(t *testing.T) {
	a := newTestApp()
	for _, tc := range []struct {
		target string
		want   []string
	}{
		{TargetAll, []string{TargetEdge, TargetQuery, TargetAPI, TargetIdentity}},
		{TargetIdentity, []string{modServer, modPostgres, modValkey, TargetIdentity}},
		{TargetAPI, []string{modServer, modPostgres, modValkey, TargetAPI}},
	} {
		order, err := a.mgr.Resolve([]string{tc.target})
		if err != nil {
			t.Fatalf("Resolve(%s): %v", tc.target, err)
		}
		for _, name := range tc.want {
			if !slices.Contains(order, name) {
				t.Errorf("Resolve(%s) = %v, missing %q", tc.target, order, name)
			}
		}
		// The listener must start after every route-registering module.
		http := slices.Index(order, modHTTP)
		if http < 0 {
			t.Fatalf("Resolve(%s) = %v, missing %q", tc.target, order, modHTTP)
		}
		for _, name := range []string{TargetAPI, TargetIdentity} {
			if i := slices.Index(order, name); i > http {
				t.Errorf("Resolve(%s) = %v: %q starts after %q", tc.target, order, name, modHTTP)
			}
		}
	}
}
