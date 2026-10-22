package modules

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.events)
}

// blocking returns an init func whose service records start/stop.
func blocking(rec *recorder, name string) InitFunc {
	return func(context.Context) (Service, error) {
		rec.add("init:" + name)
		return ServiceFunc(func(ctx context.Context) error {
			<-ctx.Done()
			rec.add("stop:" + name)
			return nil
		}), nil
	}
}

func TestResolveOrdersDependenciesFirst(t *testing.T) {
	m := New(nil, time.Second)
	noop := func(context.Context) (Service, error) { return nil, nil }
	m.Register("db", noop, Invisible())
	m.Register("server", noop, Invisible())
	m.Register("edge", noop, DependsOn("server", "db"))
	m.Register("query", noop, DependsOn("server", "db"))
	m.Register("all", noop, DependsOn("edge", "query"))

	got, err := m.Resolve([]string{"all"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"server", "db", "edge", "query", "all"}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if targets := m.Targets(); !slices.Equal(targets, []string{"all", "edge", "query"}) {
		t.Fatalf("targets = %v", targets)
	}
}

func TestResolveErrors(t *testing.T) {
	noop := func(context.Context) (Service, error) { return nil, nil }
	m := New(nil, time.Second)
	m.Register("db", noop, Invisible())
	m.Register("a", noop, DependsOn("b"))
	m.Register("b", noop, DependsOn("a"))
	m.Register("c", noop, DependsOn("missing"))

	cases := map[string]struct {
		targets []string
		want    string
	}{
		"empty":     {nil, "no target"},
		"unknown":   {[]string{"nope"}, `unknown target "nope"`},
		"invisible": {[]string{"db"}, "internal"},
		"cycle":     {[]string{"a"}, "cycle"},
		"bad dep":   {[]string{"c"}, `unknown module "missing"`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := m.Resolve(tc.targets)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want containing %q", err, tc.want)
			}
		})
	}
}

func TestRunStopsInReverseOrder(t *testing.T) {
	rec := &recorder{}
	m := New(nil, time.Second)
	m.Register("db", blocking(rec, "db"), Invisible())
	m.Register("api", blocking(rec, "api"), DependsOn("db"))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.Run(ctx, []string{"api"}) }()

	waitFor(t, func() bool { return len(rec.list()) >= 2 })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v", err)
	}
	want := []string{"init:db", "init:api", "stop:api", "stop:db"}
	if got := rec.list(); !slices.Equal(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestRunFailureStopsEverything(t *testing.T) {
	rec := &recorder{}
	boom := errors.New("boom")
	m := New(nil, time.Second)
	m.Register("db", blocking(rec, "db"), Invisible())
	m.Register("api", func(context.Context) (Service, error) {
		return ServiceFunc(func(context.Context) error { return boom }), nil
	}, DependsOn("db"))

	err := m.Run(context.Background(), []string{"api"})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if got := rec.list(); !slices.Contains(got, "stop:db") {
		t.Fatalf("db was not stopped: %v", got)
	}
}

func TestRunInitErrorAborts(t *testing.T) {
	m := New(nil, time.Second)
	m.Register("api", func(context.Context) (Service, error) { return nil, errors.New("bad config") })
	if err := m.Run(context.Background(), []string{"api"}); err == nil || !strings.Contains(err.Error(), "init api") {
		t.Fatalf("err = %v", err)
	}
}

func TestRegisterTwicePanics(t *testing.T) {
	m := New(nil, time.Second)
	noop := func(context.Context) (Service, error) { return nil, nil }
	m.Register("x", noop)
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	m.Register("x", noop)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAfterAndAlways(t *testing.T) {
	noop := func(context.Context) (Service, error) { return nil, nil }
	m := New(nil, time.Second)
	m.Register("server", noop, Invisible())
	m.Register("sink", noop, Invisible())
	m.Register("edge", noop, DependsOn("server", "sink"))
	m.Register("api", noop, DependsOn("server"))
	m.Register("http", noop, Invisible(), DependsOn("server"), After("edge", "api"))
	m.Always("http")

	got, err := m.Resolve([]string{"edge"})
	if err != nil {
		t.Fatal(err)
	}
	// http comes after edge (so it stops first) and api is NOT pulled in.
	want := []string{"server", "sink", "edge", "http"}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}
