package catalog

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Environments come from the SDK too (#788, D11 in #753): an environment
// name the project does not have is registered with source 'sdk', and the
// environments data names have their last_seen_at moved forward. None of it
// runs on the request path: EnvironmentRegistry.Seen only checks an
// in-process throttle and hands the work to a goroutine, so a project and
// environment costs at most one Postgres write a minute per process however
// many requests name it. Records are stored whether or not the environment
// could be registered (a limit, an unusable name).

// EnvironmentStore is the store subset the registry needs; *db.Queries
// satisfies it.
type EnvironmentStore interface {
	ListProjectEnvironmentNames(ctx context.Context, projectID uuid.UUID) ([]string, error)
	TouchEnvironmentSeen(ctx context.Context, arg db.TouchEnvironmentSeenParams) (int64, error)
}

// EnvironmentRegistrar registers an environment under the project limits;
// *projects.EnvironmentProvisioner satisfies it.
type EnvironmentRegistrar interface {
	Register(ctx context.Context, projectID, keyID uuid.UUID, name string, seenAt time.Time) (bool, error)
}

// EnvironmentSeenInterval bounds how often one process writes for one
// project and environment.
const EnvironmentSeenInterval = time.Minute

// Reasons an environment data names is not registered (the
// apilens_ingest_environments_unregistered_total reason label).
const (
	EnvReasonLimit       = "environment_limit"      // the project has projects.MaxEnvironments
	EnvReasonRateLimit   = "environment_rate_limit" // projects.MaxNewSDKEnvironmentsPerHour reached
	EnvReasonInvalidName = "invalid_environment"    // does not match projects.EnvironmentPattern
)

type envKey struct {
	project uuid.UUID
	name    string
}

type projectEnvs struct {
	names    map[string]bool
	loadedAt time.Time
}

// EnvironmentRegistry registers the environments ingest sees and keeps
// their last_seen_at current. Each project's environment names are cached
// for ttl; a name missing from the cache goes through the registrar (which
// re-checks under a project lock), a cached name only moves last_seen_at.
type EnvironmentRegistry struct {
	store    EnvironmentStore
	reg      EnvironmentRegistrar
	ttl      time.Duration
	interval time.Duration
	logger   *slog.Logger
	now      func() time.Time
	// run starts the background work of one Seen call.
	run func(func())

	mu    sync.RWMutex
	cache map[uuid.UUID]*projectEnvs
	group singleflight.Group

	seenMu sync.Mutex
	seen   map[envKey]time.Time

	writes       *prometheus.CounterVec
	registered   prometheus.Counter
	unregistered *prometheus.CounterVec
}

// NewEnvironmentRegistry builds a registry. reg may be nil.
func NewEnvironmentRegistry(store EnvironmentStore, registrar EnvironmentRegistrar, ttl time.Duration, logger *slog.Logger, reg prometheus.Registerer) *EnvironmentRegistry {
	r := &EnvironmentRegistry{
		store: store, reg: registrar, ttl: ttl, interval: EnvironmentSeenInterval, logger: logger, now: time.Now,
		run:   func(f func()) { go f() },
		cache: map[uuid.UUID]*projectEnvs{}, seen: map[envKey]time.Time{},
		writes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_ingest_environment_writes_total",
			Help: "Postgres writes ingest made for environments, by operation (touch: last seen moved forward; register: an environment it had not cached). At most one per project, environment and minute per process.",
		}, []string{"op"}),
		registered: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "apilens_ingest_environments_registered_total", Help: "Environments ingest registered from the environment names SDKs send.",
		}),
		unregistered: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_ingest_environments_unregistered_total",
			Help: "Attempts to register an environment SDKs send that were refused, by reason (environment_limit, environment_rate_limit, invalid_environment). Its records are stored anyway.",
		}, []string{"reason"}),
	}
	for _, op := range []string{"touch", "register"} {
		r.writes.WithLabelValues(op)
	}
	for _, reason := range []string{EnvReasonLimit, EnvReasonRateLimit, EnvReasonInvalidName} {
		r.unregistered.WithLabelValues(reason)
	}
	if reg != nil {
		reg.MustRegister(r.writes, r.registered, r.unregistered)
	}
	return r
}

// Seen records that data of the project, sent with keyID, named the
// environments names. It does not block: the writes it needs run in the
// background, at most once per project and environment per
// EnvironmentSeenInterval.
func (r *EnvironmentRegistry) Seen(projectID, keyID uuid.UUID, names []string) {
	now := r.now()
	var due []string
	r.seenMu.Lock()
	if len(r.seen) > 100_000 {
		r.seen = map[envKey]time.Time{}
	}
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		k := envKey{projectID, n}
		if last, ok := r.seen[k]; ok && now.Sub(last) < r.interval {
			continue
		}
		r.seen[k] = now
		due = append(due, n)
	}
	r.seenMu.Unlock()
	if len(due) == 0 {
		return
	}
	r.run(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, n := range due {
			r.record(ctx, projectID, keyID, n, now)
		}
	})
}

func (r *EnvironmentRegistry) record(ctx context.Context, projectID, keyID uuid.UUID, name string, at time.Time) {
	if !projects.ValidEnvironment(name) {
		r.unregistered.WithLabelValues(EnvReasonInvalidName).Inc()
		return
	}
	known, err := r.known(ctx, projectID, name)
	if err != nil {
		r.logger.Warn("environment list unavailable", "project_id", projectID, "error", err)
		return
	}
	if known {
		seen := at.UTC()
		r.writes.WithLabelValues("touch").Inc()
		n, err := r.store.TouchEnvironmentSeen(ctx, db.TouchEnvironmentSeenParams{ProjectID: projectID, Name: name, SeenAt: &seen})
		if err != nil {
			r.logger.Warn("failed to record environment last seen", "project_id", projectID, "environment", name, "error", err)
			return
		}
		if n > 0 {
			return
		}
		// Removed since the cache was loaded: register it again.
		r.Forget(projectID)
	}
	r.writes.WithLabelValues("register").Inc()
	created, err := r.reg.Register(ctx, projectID, keyID, name, at)
	var limit *projects.EnvironmentLimitError
	switch {
	case errors.As(err, &limit):
		reason := EnvReasonLimit
		if limit.Limit == projects.EnvLimitNewPerHour {
			reason = EnvReasonRateLimit
		}
		r.unregistered.WithLabelValues(reason).Inc()
		r.logger.Info("environment not registered", "project_id", projectID, "environment", name, "reason", reason, "max", limit.Max)
		return
	case errors.Is(err, projects.ErrInvalid):
		r.unregistered.WithLabelValues(EnvReasonInvalidName).Inc()
		return
	case err != nil:
		r.logger.Warn("failed to register environment", "project_id", projectID, "environment", name, "error", err)
		return
	}
	r.mu.Lock()
	if pe, ok := r.cache[projectID]; ok {
		pe.names[name] = true
	}
	r.mu.Unlock()
	if created {
		r.registered.Inc()
		r.logger.Info("environment registered from ingest", "project_id", projectID, "environment", name, "key_id", keyID)
	}
}

// known reports whether the project has the environment name, from a cache
// loaded at most ttl ago.
func (r *EnvironmentRegistry) known(ctx context.Context, projectID uuid.UUID, name string) (bool, error) {
	r.mu.RLock()
	pe, ok := r.cache[projectID]
	fresh := ok && r.now().Sub(pe.loadedAt) < r.ttl
	has := ok && pe.names[name]
	r.mu.RUnlock()
	if fresh {
		return has, nil
	}
	v, err, _ := r.group.Do(projectID.String(), func() (any, error) {
		names, err := r.store.ListProjectEnvironmentNames(ctx, projectID)
		if err != nil {
			return nil, err
		}
		pe := &projectEnvs{names: make(map[string]bool, len(names)), loadedAt: r.now()}
		for _, n := range names {
			pe.names[n] = true
		}
		r.mu.Lock()
		r.cache[projectID] = pe
		r.mu.Unlock()
		return pe, nil
	})
	if err != nil {
		return false, err
	}
	pe = v.(*projectEnvs)
	r.mu.RLock()
	defer r.mu.RUnlock()
	return pe.names[name], nil
}

// Forget drops a project from the cache.
func (r *EnvironmentRegistry) Forget(projectID uuid.UUID) {
	r.mu.Lock()
	delete(r.cache, projectID)
	r.mu.Unlock()
}
