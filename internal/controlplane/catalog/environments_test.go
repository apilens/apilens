package catalog

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// fakeEnvs is a project's environments table: names in the store plus the
// registrar's limits.
type fakeEnvs struct {
	mu      sync.Mutex
	names   map[string]bool
	lists   int
	touches []string
	regs    []string
	limit   *projects.EnvironmentLimitError // returned for names not in the table
}

func (f *fakeEnvs) ListProjectEnvironmentNames(context.Context, uuid.UUID) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists++
	out := make([]string, 0, len(f.names))
	for n := range f.names {
		out = append(out, n)
	}
	return out, nil
}

func (f *fakeEnvs) TouchEnvironmentSeen(_ context.Context, arg db.TouchEnvironmentSeenParams) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touches = append(f.touches, arg.Name)
	if f.names[arg.Name] {
		return 1, nil
	}
	return 0, nil
}

func (f *fakeEnvs) Register(_ context.Context, _, _ uuid.UUID, name string, _ time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.regs = append(f.regs, name)
	if f.names[name] {
		return false, nil
	}
	if f.limit != nil {
		return false, f.limit
	}
	f.names[name] = true
	return true, nil
}

func newTestRegistry(f *fakeEnvs, now *time.Time) *EnvironmentRegistry {
	r := NewEnvironmentRegistry(f, f, 5*time.Minute, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	r.now = func() time.Time { return *now }
	r.run = func(fn func()) { fn() } // synchronous for tests
	return r
}

func (r *EnvironmentRegistry) writeCount() float64 {
	return testutil.ToFloat64(r.writes.WithLabelValues("touch")) + testutil.ToFloat64(r.writes.WithLabelValues("register"))
}

func TestEnvironmentRegistryRegistersOnceAndThrottles(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	f := &fakeEnvs{names: map[string]bool{"production": true}}
	r := newTestRegistry(f, &now)
	project, key := uuid.New(), uuid.New()

	// 1000 requests naming two environments within a minute: one write
	// each, never one per request.
	for range 1000 {
		r.Seen(project, key, []string{"production", "staging"})
	}
	if got := r.writeCount(); got != 2 {
		t.Fatalf("writes = %v, want 2", got)
	}
	if len(f.regs) != 1 || f.regs[0] != "staging" || len(f.touches) != 1 || f.touches[0] != "production" {
		t.Fatalf("regs %v touches %v", f.regs, f.touches)
	}
	if !f.names["staging"] || testutil.ToFloat64(r.registered) != 1 {
		t.Fatalf("staging not registered: %v", f.names)
	}

	// A minute later both only move last seen (staging is cached now).
	now = now.Add(EnvironmentSeenInterval)
	r.Seen(project, key, []string{"production", "staging"})
	if len(f.regs) != 1 || len(f.touches) != 3 {
		t.Fatalf("regs %v touches %v", f.regs, f.touches)
	}
	if f.lists != 1 {
		t.Fatalf("environment list loaded %d times", f.lists)
	}
}

func TestEnvironmentRegistryReRegistersRemovedEnvironment(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	f := &fakeEnvs{names: map[string]bool{"qa": true}}
	r := newTestRegistry(f, &now)
	project := uuid.New()
	r.Seen(project, uuid.New(), []string{"qa"})
	// Deleted from the dashboard while cached: the touch finds no row, so
	// the environment is registered again.
	f.mu.Lock()
	delete(f.names, "qa")
	f.mu.Unlock()
	now = now.Add(EnvironmentSeenInterval)
	r.Seen(project, uuid.New(), []string{"qa"})
	if !f.names["qa"] || len(f.regs) != 1 {
		t.Fatalf("names %v regs %v", f.names, f.regs)
	}
}

func TestEnvironmentRegistryLimits(t *testing.T) {
	for _, c := range []struct {
		limit  string
		reason string
	}{
		{projects.EnvLimitMax, EnvReasonLimit},
		{projects.EnvLimitNewPerHour, EnvReasonRateLimit},
	} {
		t.Run(c.reason, func(t *testing.T) {
			now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
			f := &fakeEnvs{names: map[string]bool{}, limit: &projects.EnvironmentLimitError{Limit: c.limit, Max: 5}}
			r := newTestRegistry(f, &now)
			project := uuid.New()
			for range 10 {
				r.Seen(project, uuid.New(), []string{"build-1234"})
			}
			if f.names["build-1234"] || len(f.regs) != 1 {
				t.Fatalf("names %v regs %v", f.names, f.regs)
			}
			if n := testutil.ToFloat64(r.unregistered.WithLabelValues(c.reason)); n != 1 {
				t.Fatalf("unregistered{%s} = %v", c.reason, n)
			}
			// Retried after the throttle interval, not before.
			now = now.Add(EnvironmentSeenInterval)
			r.Seen(project, uuid.New(), []string{"build-1234"})
			if len(f.regs) != 2 {
				t.Fatalf("regs %v", f.regs)
			}
		})
	}
}

func TestEnvironmentRegistrySkipsUnusableNames(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	f := &fakeEnvs{names: map[string]bool{}}
	r := newTestRegistry(f, &now)
	r.Seen(uuid.New(), uuid.New(), []string{"my env", " ", "-x"})
	if r.writeCount() != 0 || f.lists != 0 {
		t.Fatalf("writes %v lists %d", r.writeCount(), f.lists)
	}
	if n := testutil.ToFloat64(r.unregistered.WithLabelValues(EnvReasonInvalidName)); n != 2 {
		t.Fatalf("invalid = %v", n)
	}
}
