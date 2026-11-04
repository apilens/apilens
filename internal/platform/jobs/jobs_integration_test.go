//go:build integration

package jobs_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

type echoArgs struct {
	Msg string `json:"msg"`
}

func (echoArgs) Kind() string { return "test.echo" }

type slowArgs struct{}

func (slowArgs) Kind() string { return "test.slow" }

var enabled = config.JobsConfig{Enabled: true, MaxWorkers: 2, MetricsInterval: 50 * time.Millisecond}

// run starts c.Run and returns a stop func that cancels it and reports how
// long Run took to return.
func run(t *testing.T, c *jobs.Client) func() (time.Duration, error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	stopped := false
	stop := func() (time.Duration, error) {
		stopped = true
		start := time.Now()
		cancel()
		select {
		case err := <-done:
			return time.Since(start), err
		case <-time.After(30 * time.Second):
			t.Fatal("Run did not return")
			return 0, nil
		}
	}
	t.Cleanup(func() {
		if !stopped {
			_, _ = stop()
		}
	})
	return stop
}

func newClient(t *testing.T, pool *pgxpool.Pool, cfg config.JobsConfig, reg *jobs.Registry, shutdown time.Duration) (*jobs.Client, *prometheus.Registry) {
	t.Helper()
	promReg := prometheus.NewRegistry()
	c, err := jobs.New(pool, cfg, reg, shutdown, testutil.Logger(t), promReg)
	if err != nil {
		t.Fatal(err)
	}
	return c, promReg
}

func waitState(t *testing.T, c *jobs.Client, id int64, want rivertype.JobState) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		job, err := c.River().JobGet(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if job.State == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %d state = %s, want %s", id, job.State, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func depth(t *testing.T, reg *prometheus.Registry, queue, state string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "apilens_jobs_queue_depth" {
			continue
		}
		for _, m := range mf.GetMetric() {
			labels := map[string]string{}
			for _, l := range m.GetLabel() {
				labels[l.GetName()] = l.GetValue()
			}
			if labels["queue"] == queue && labels["state"] == state {
				return m.GetGauge().GetValue()
			}
		}
	}
	t.Fatalf("no apilens_jobs_queue_depth{queue=%q,state=%q}", queue, state)
	return 0
}

func TestJobRoundTrip(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	c, promReg := newClient(t, pool, enabled, reg, 10*time.Second)

	// Workers registered after New (during module init) are still worked.
	got := make(chan string, 1)
	jobs.Register(reg, river.WorkFunc(func(_ context.Context, j *river.Job[echoArgs]) error {
		got <- j.Args.Msg
		return nil
	}))

	// Queue depth sees a job scheduled for later.
	if _, err := c.Insert(ctx, echoArgs{Msg: "later"}, &river.InsertOpts{ScheduledAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := c.SampleQueueDepth(ctx); err != nil {
		t.Fatal(err)
	}
	if n := depth(t, promReg, river.QueueDefault, "scheduled"); n != 1 {
		t.Errorf("scheduled depth = %v, want 1", n)
	}
	if n := depth(t, promReg, river.QueueDefault, "available"); n != 0 {
		t.Errorf("available depth = %v, want 0", n)
	}

	run(t, c)

	// Insert inside a transaction: visible only once committed.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.InsertTx(ctx, tx, echoArgs{Msg: "hello"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-got:
		if msg != "hello" {
			t.Fatalf("worker got %q", msg)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("job was not worked")
	}
	waitState(t, c, res.Job.ID, rivertype.JobStateCompleted)
}

func TestShutdownDrainsInFlightJobs(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	started := make(chan struct{}, 1)
	jobs.Register(reg, river.WorkFunc(func(ctx context.Context, _ *river.Job[slowArgs]) error {
		started <- struct{}{}
		select {
		case <-time.After(500 * time.Millisecond):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}))
	c, _ := newClient(t, pool, enabled, reg, 10*time.Second)
	stop := run(t, c)

	res, err := c.Insert(ctx, slowArgs{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("job did not start")
	}
	took, err := stop()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if took >= 10*time.Second {
		t.Errorf("shutdown took %v, want within shutdown_timeout", took)
	}
	waitState(t, c, res.Job.ID, rivertype.JobStateCompleted)
}

func TestShutdownCancelsJobsPastTimeout(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	started := make(chan struct{}, 1)
	jobs.Register(reg, river.WorkFunc(func(ctx context.Context, _ *river.Job[slowArgs]) error {
		started <- struct{}{}
		<-ctx.Done() // only stops when cancelled
		return ctx.Err()
	}))
	const timeout = 2 * time.Second
	c, _ := newClient(t, pool, enabled, reg, timeout)
	stop := run(t, c)

	res, err := c.Insert(ctx, slowArgs{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("job did not start")
	}
	took, err := stop()
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if took > timeout+time.Second {
		t.Errorf("shutdown took %v, want about %v", took, timeout)
	}
	job, err := c.River().JobGet(ctx, res.Job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.State == rivertype.JobStateCompleted {
		t.Error("a job cancelled at shutdown must not be marked completed")
	}
}

func TestDisabledDoesNotWork(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[echoArgs]) error {
		t.Error("worker ran with jobs.enabled=false")
		return nil
	}))
	cfg := enabled
	cfg.Enabled = false
	c, _ := newClient(t, pool, cfg, reg, 5*time.Second)
	stop := run(t, c)

	res, err := c.Insert(ctx, echoArgs{Msg: "queued"}, nil)
	if err != nil {
		t.Fatalf("insert-only client must still enqueue: %v", err)
	}
	time.Sleep(time.Second)
	if _, err := stop(); err != nil {
		t.Fatal(err)
	}
	job, err := c.River().JobGet(ctx, res.Job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.State != rivertype.JobStateAvailable {
		t.Errorf("state = %s, want available", job.State)
	}
}
