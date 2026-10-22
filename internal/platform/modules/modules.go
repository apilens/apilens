// Package modules is a small lifecycle manager for the role-based binary.
//
// It follows the semantics of grafana/dskit's modules package without the
// dependency: modules are registered with their dependencies, a target list
// is resolved into a dependency-ordered set, every module is initialised in
// that order, then all resulting services run concurrently. On shutdown (or
// when any service fails) services are stopped in reverse order, so a
// module's dependents always stop before the module itself.
package modules

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Service is a long-running component. Run must block until ctx is cancelled
// (returning nil) or the service fails (returning an error). A service that
// returns nil before ctx is cancelled is treated as finished and does not
// stop the others.
type Service interface {
	Run(ctx context.Context) error
}

// ServiceFunc adapts a function to Service.
type ServiceFunc func(ctx context.Context) error

// Run implements Service.
func (f ServiceFunc) Run(ctx context.Context) error { return f(ctx) }

// InitFunc builds a module. It may return a nil Service for modules that only
// wire state (for example registering HTTP routes on a shared server).
type InitFunc func(ctx context.Context) (Service, error)

type module struct {
	name    string
	deps    []string
	after   []string
	init    InitFunc
	visible bool
}

// Option configures a registered module.
type Option func(*module)

// Invisible hides a module from the list of user-selectable targets. Use it
// for infrastructure modules (database pools, the HTTP server) that are only
// ever pulled in as dependencies.
func Invisible() Option { return func(m *module) { m.visible = false } }

// DependsOn declares the modules this module needs.
func DependsOn(deps ...string) Option {
	return func(m *module) { m.deps = append(m.deps, deps...) }
}

// After adds ordering-only constraints: if any of the named modules are part
// of the resolved set, this module initialises after them (and therefore
// stops before them). Unlike DependsOn it never pulls those modules in. The
// HTTP listener uses it to start after, and stop before, every module that
// registers routes.
func After(names ...string) Option {
	return func(m *module) { m.after = append(m.after, names...) }
}

// Manager holds the module registry. It is not safe for concurrent
// registration; build it once at startup.
type Manager struct {
	modules         map[string]*module
	always          []string
	logger          *slog.Logger
	shutdownTimeout time.Duration
}

// Always marks modules that are included in every Run regardless of the
// requested targets (for example the HTTP listener).
func (m *Manager) Always(names ...string) { m.always = append(m.always, names...) }

// New returns an empty Manager.
func New(logger *slog.Logger, shutdownTimeout time.Duration) *Manager {
	if logger == nil {
		logger = slog.Default()
	}
	if shutdownTimeout <= 0 {
		shutdownTimeout = 30 * time.Second
	}
	return &Manager{modules: map[string]*module{}, logger: logger, shutdownTimeout: shutdownTimeout}
}

// Register adds a module. Registering the same name twice panics: it is a
// programming error caught by the first test run.
func (m *Manager) Register(name string, init InitFunc, opts ...Option) {
	if _, dup := m.modules[name]; dup {
		panic(fmt.Sprintf("modules: %q registered twice", name))
	}
	mod := &module{name: name, init: init, visible: true}
	for _, o := range opts {
		o(mod)
	}
	m.modules[name] = mod
}

// Targets returns the user-visible module names, sorted.
func (m *Manager) Targets() []string {
	var out []string
	for name, mod := range m.modules {
		if mod.visible {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// Resolve expands targets into all required modules in dependency order
// (dependencies first). It rejects unknown names, invisible targets and
// dependency cycles.
func (m *Manager) Resolve(targets []string) ([]string, error) {
	if len(targets) == 0 {
		return nil, errors.New("modules: no target given")
	}
	for _, t := range targets {
		mod, ok := m.modules[t]
		if !ok {
			return nil, fmt.Errorf("modules: unknown target %q (available: %s)", t, strings.Join(m.Targets(), ", "))
		}
		if !mod.visible {
			return nil, fmt.Errorf("modules: %q is internal and cannot be used as a target", t)
		}
	}

	// 1. Collect the required set by following hard dependencies.
	required := map[string]bool{}
	var collect func(name, from string) error
	collect = func(name, from string) error {
		if required[name] {
			return nil
		}
		mod, ok := m.modules[name]
		if !ok {
			return fmt.Errorf("modules: %q depends on unknown module %q", from, name)
		}
		required[name] = true
		for _, dep := range mod.deps {
			if err := collect(dep, name); err != nil {
				return err
			}
		}
		return nil
	}
	roots := append(slices.Clone(targets), m.always...)
	for _, r := range roots {
		if err := collect(r, "<always>"); err != nil {
			return nil, err
		}
	}

	// 2. Topologically sort the set over deps plus in-set "after" edges.
	const (
		visiting = 1
		done     = 2
	)
	state := map[string]int{}
	var order []string
	var visit func(name string, path []string) error
	visit = func(name string, path []string) error {
		switch state[name] {
		case done:
			return nil
		case visiting:
			return fmt.Errorf("modules: dependency cycle: %s -> %s", strings.Join(path, " -> "), name)
		}
		state[name] = visiting
		mod := m.modules[name]
		edges := slices.Clone(mod.deps)
		for _, a := range mod.after {
			if required[a] {
				edges = append(edges, a)
			}
		}
		for _, dep := range edges {
			if err := visit(dep, append(path, name)); err != nil {
				return err
			}
		}
		state[name] = done
		order = append(order, name)
		return nil
	}
	for _, r := range roots {
		if err := visit(r, nil); err != nil {
			return nil, err
		}
	}
	return order, nil
}

type running struct {
	name string
	svc  Service
}

// Run initialises every module required by targets, runs the resulting
// services until ctx is cancelled or one of them fails, then stops them in
// reverse dependency order. It returns the first service error, if any.
func (m *Manager) Run(ctx context.Context, targets []string) error {
	order, err := m.Resolve(targets)
	if err != nil {
		return err
	}
	m.logger.Info("starting modules", "targets", targets, "modules", order)

	var services []running
	for _, name := range order {
		svc, err := m.modules[name].init(ctx)
		if err != nil {
			return fmt.Errorf("modules: init %s: %w", name, err)
		}
		if svc != nil {
			services = append(services, running{name: name, svc: svc})
		}
	}

	// Each service gets its own context so we can cancel them one by one in
	// reverse order. failed carries the first unexpected error.
	type handle struct {
		name   string
		cancel context.CancelFunc
		done   chan struct{}
	}
	handles := make([]handle, 0, len(services))
	failed := make(chan error, len(services))
	var errOnce sync.Once
	var firstErr error

	for _, s := range services {
		sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		h := handle{name: s.name, cancel: cancel, done: make(chan struct{})}
		handles = append(handles, h)
		go func(s running, h handle) {
			defer close(h.done)
			err := s.svc.Run(sctx)
			if err != nil && sctx.Err() == nil {
				errOnce.Do(func() { firstErr = fmt.Errorf("modules: %s failed: %w", s.name, err) })
				failed <- err
			}
		}(s, h)
	}

	select {
	case <-ctx.Done():
		m.logger.Info("shutdown requested")
	case err := <-failed:
		m.logger.Error("module failed, shutting down", "error", err)
	}

	deadline := time.Now().Add(m.shutdownTimeout)
	for _, h := range slices.Backward(handles) {
		h.cancel()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			remaining = time.Millisecond
		}
		select {
		case <-h.done:
			m.logger.Debug("module stopped", "module", h.name)
		case <-time.After(remaining):
			m.logger.Warn("module did not stop before shutdown timeout", "module", h.name)
		}
	}
	return firstErr
}
