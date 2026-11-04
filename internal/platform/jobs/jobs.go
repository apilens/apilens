// Package jobs runs background jobs with River (ADR 0008) on the shared pgx
// pool.
//
// Modules register workers on a Registry during init; the Client then works
// them once the process runs. Roles that only enqueue (or run with
// jobs.enabled=false) get an insert-only client. River's tables are created by
// `apilens migrate` (see migrations.UpRiver).
package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/platform/config"
)

// Registry collects the workers a process can run. It is filled during module
// init, before the Client starts.
type Registry struct {
	mu      sync.Mutex
	workers *river.Workers
	kinds   []string
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry { return &Registry{workers: river.NewWorkers()} }

// Register adds the worker for job args of type T. Registering the same kind
// twice is a programming error and panics.
func Register[T river.JobArgs](r *Registry, w river.Worker[T]) {
	r.mu.Lock()
	defer r.mu.Unlock()
	river.AddWorker(r.workers, w)
	var args T
	r.kinds = append(r.kinds, args.Kind())
}

// Kinds returns the registered job kinds, sorted.
func (r *Registry) Kinds() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Sorted(slices.Values(r.kinds))
}

// Client wraps a river.Client and runs its worker loop as a module service.
type Client struct {
	river           *river.Client[pgx.Tx]
	pool            *pgxpool.Pool
	registry        *Registry
	cfg             config.JobsConfig
	shutdownTimeout time.Duration
	logger          *slog.Logger
	depth           *prometheus.GaugeVec
}

// New builds a Client on pool. Workers registered on registry after New but
// before Run are picked up. shutdownTimeout bounds how long Run waits for
// in-flight jobs to finish on shutdown before cancelling them.
func New(pool *pgxpool.Pool, cfg config.JobsConfig, registry *Registry, shutdownTimeout time.Duration, logger *slog.Logger, reg prometheus.Registerer) (*Client, error) {
	rcfg := &river.Config{
		Logger:  logger.With("component", "river"),
		Workers: registry.workers,
	}
	if cfg.Enabled {
		rcfg.Queues = map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: cfg.MaxWorkers}}
	}
	rc, err := river.NewClient(riverpgxv5.New(pool), rcfg)
	if err != nil {
		return nil, fmt.Errorf("jobs: new client: %w", err)
	}
	depth := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "apilens_jobs_queue_depth",
		Help: "Background jobs per queue and state (available, scheduled, retryable, running).",
	}, []string{"queue", "state"})
	if reg != nil {
		if err := reg.Register(depth); err != nil {
			return nil, fmt.Errorf("jobs: register metrics: %w", err)
		}
	}
	if shutdownTimeout <= 0 {
		shutdownTimeout = 30 * time.Second
	}
	return &Client{
		river: rc, pool: pool, registry: registry, cfg: cfg,
		shutdownTimeout: shutdownTimeout, logger: logger, depth: depth,
	}, nil
}

// River exposes the underlying client (subscriptions, job queries, tests).
func (c *Client) River() *river.Client[pgx.Tx] { return c.river }

// Insert enqueues a job.
func (c *Client) Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	return c.river.Insert(ctx, args, opts)
}

// InsertTx enqueues a job inside tx, so it becomes visible only if tx commits.
func (c *Client) InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	return c.river.InsertTx(ctx, tx, args, opts)
}

// Run works jobs until ctx is cancelled, then drains: in-flight jobs get most
// of shutdownTimeout to finish, after which their contexts are cancelled.
// With jobs.enabled=false or no registered workers it only samples metrics.
func (c *Client) Run(ctx context.Context) error {
	working := c.cfg.Enabled && len(c.registry.Kinds()) > 0
	if !working {
		if c.cfg.Enabled {
			c.logger.Info("jobs: no workers registered; worker loop not started")
		} else {
			c.logger.Info("jobs: disabled (jobs.enabled=false); worker loop not started")
		}
		c.sampleUntil(ctx)
		return nil
	}

	// Start's context cancels in-flight jobs when done, so it must outlive ctx:
	// shutdown is driven by Stop below.
	runCtx, cancelRun := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelRun()
	if err := c.river.Start(runCtx); err != nil {
		return fmt.Errorf("jobs: start: %w", err)
	}
	c.logger.Info("jobs: worker loop started", "kinds", c.registry.Kinds(), "max_workers", c.cfg.MaxWorkers)

	sampleCtx, stopSampling := context.WithCancel(ctx)
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		c.sampleUntil(sampleCtx)
	}()
	defer func() { stopSampling(); <-sampled }()

	select {
	case <-ctx.Done():
		return c.stop()
	case <-c.river.Stopped():
		return errors.New("jobs: river client stopped unexpectedly")
	}
}

// stop drains in-flight jobs, then cancels whatever is still running.
func (c *Client) stop() error {
	grace := min(c.shutdownTimeout/5, 5*time.Second)
	softCtx, cancel := context.WithTimeout(context.Background(), c.shutdownTimeout-grace)
	defer cancel()
	err := c.river.Stop(softCtx)
	if err == nil {
		c.logger.Info("jobs: drained")
		return nil
	}
	c.logger.Warn("jobs: in-flight jobs did not finish in time; cancelling them", "error", err)
	hardCtx, cancelHard := context.WithTimeout(context.Background(), grace)
	defer cancelHard()
	if err := c.river.StopAndCancel(hardCtx); err != nil {
		return fmt.Errorf("jobs: stop: %w", err)
	}
	return nil
}

func (c *Client) sampleUntil(ctx context.Context) {
	t := time.NewTicker(c.cfg.MetricsInterval)
	defer t.Stop()
	for {
		if err := c.SampleQueueDepth(ctx); err != nil && ctx.Err() == nil {
			c.logger.Warn("jobs: sample queue depth", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// pendingStates are the job states counted as queue depth.
var pendingStates = []string{
	string(rivertype.JobStateAvailable), string(rivertype.JobStateScheduled),
	string(rivertype.JobStateRetryable), string(rivertype.JobStateRunning),
}

// SampleQueueDepth refreshes the apilens_jobs_queue_depth gauge.
func (c *Client) SampleQueueDepth(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	rows, err := c.pool.Query(ctx,
		`SELECT queue, state::text, count(*) FROM river_job WHERE state::text = ANY($1) GROUP BY 1, 2`, pendingStates)
	if err != nil {
		return err
	}
	type key struct{ queue, state string }
	counts := map[key]float64{}
	for rows.Next() {
		var k key
		var n int64
		if err := rows.Scan(&k.queue, &k.state, &n); err != nil {
			rows.Close()
			return err
		}
		counts[k] = float64(n)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	c.depth.Reset()
	// Always report the default queue so dashboards see zeros, not gaps.
	for _, s := range pendingStates {
		c.depth.WithLabelValues(river.QueueDefault, s).Set(0)
	}
	for k, n := range counts {
		c.depth.WithLabelValues(k.queue, k.state).Set(n)
	}
	return nil
}
