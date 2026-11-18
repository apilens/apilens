package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ErrOverloaded means the sink queue is full. The edge maps it to 503 with
// Retry-After so SDKs back off and retry.
var ErrOverloaded = errors.New("pipeline: overloaded")

// ErrClosed means the sink is shutting down.
var ErrClosed = errors.New("pipeline: closed")

// Inserter writes one batch of rows. It must be safe for concurrent use.
type Inserter[T any] func(ctx context.Context, rows []T) error

// BatcherOptions tunes a Batcher.
type BatcherOptions struct {
	BatchSize     int           // flush when this many rows are buffered
	FlushInterval time.Duration // flush at least this often
	QueueSize     int           // submissions buffered before ErrOverloaded
	Workers       int           // concurrent inserts
	InsertTimeout time.Duration // bound of one insert attempt
	// RetryWindow is how long a failing insert is retried, with exponential
	// backoff, before its rows are given up; 0 makes a single attempt.
	RetryWindow time.Duration
	// WaitForFlush makes Submit block until the rows are stored (group
	// commit). Otherwise Submit returns once the rows are queued.
	WaitForFlush bool
}

type submission[T any] struct {
	rows []T
	done chan error // nil when not waiting for the flush
}

type flushJob[T any] struct {
	rows    []T
	waiters []chan error
}

// Batcher groups submissions into large inserts. A single collector
// goroutine builds batches; Workers goroutines insert them. When the workers
// fall behind, the collector stops draining the queue and Submit starts
// returning ErrOverloaded: backpressure reaches clients instead of growing
// memory without bound.
type Batcher[T any] struct {
	name   string
	opts   BatcherOptions
	insert Inserter[T]
	logger *slog.Logger
	in     chan submission[T]
	jobs   chan flushJob[T]

	closeMu sync.RWMutex
	closed  bool

	metrics *Metrics

	// overloaded counts rows refused since the last overload warning;
	// overloadLog is when that warning was last logged (unix nanos).
	overloaded  atomic.Int64
	overloadLog atomic.Int64

	now   func() time.Time
	sleep func(time.Duration)
}

// Retry backoff of a failing insert: retryBackoff doubled per attempt up to
// maxRetryBackoff, within BatcherOptions.RetryWindow.
const (
	retryBackoff    = 100 * time.Millisecond
	maxRetryBackoff = 5 * time.Second
	// overloadLogEvery bounds how often refused submissions are logged.
	overloadLogEvery = time.Second
)

// NewBatcher builds a Batcher; call Run to start it.
func NewBatcher[T any](name string, insert Inserter[T], opts BatcherOptions, logger *slog.Logger, m *Metrics) *Batcher[T] {
	if opts.Workers <= 0 {
		opts.Workers = 2
	}
	return &Batcher[T]{
		name:    name,
		opts:    opts,
		insert:  insert,
		logger:  logger.With("table", name),
		in:      make(chan submission[T], opts.QueueSize),
		jobs:    make(chan flushJob[T], opts.Workers),
		metrics: m,
		now:     time.Now,
		sleep:   time.Sleep,
	}
}

// Submit hands rows to the batcher. All rows of one call are stored in the
// same insert, so a request is never half-written.
func (b *Batcher[T]) Submit(ctx context.Context, rows []T) error {
	if len(rows) == 0 {
		return nil
	}
	b.closeMu.RLock()
	if b.closed {
		b.closeMu.RUnlock()
		return ErrClosed
	}
	s := submission[T]{rows: rows}
	if b.opts.WaitForFlush {
		s.done = make(chan error, 1)
	}
	select {
	case b.in <- s:
	default:
		b.closeMu.RUnlock()
		b.metrics.rejected.WithLabelValues(b.name).Add(float64(len(rows)))
		b.warnOverloaded(len(rows))
		return ErrOverloaded
	}
	b.closeMu.RUnlock()
	b.metrics.queued.WithLabelValues(b.name).Add(float64(len(rows)))
	if s.done == nil {
		return nil
	}
	select {
	case err := <-s.done:
		return err
	case <-ctx.Done():
		// The rows are still flushed; the client just stopped waiting.
		return ctx.Err()
	}
}

// Run collects and flushes until ctx is cancelled, then drains everything
// already accepted before returning.
func (b *Batcher[T]) Run(ctx context.Context) error {
	var workers sync.WaitGroup
	for range b.opts.Workers {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range b.jobs {
				b.flush(job)
			}
		}()
	}

	ticker := time.NewTicker(b.opts.FlushInterval)
	defer ticker.Stop()
	var (
		buf     []T
		waiters []chan error
	)
	emit := func() {
		if len(buf) == 0 {
			return
		}
		b.jobs <- flushJob[T]{rows: buf, waiters: waiters}
		buf, waiters = nil, nil
	}
	add := func(s submission[T]) {
		buf = append(buf, s.rows...)
		if s.done != nil {
			waiters = append(waiters, s.done)
		}
		if len(buf) >= b.opts.BatchSize {
			emit()
		}
	}

	for {
		select {
		case s := <-b.in:
			add(s)
			b.metrics.depth.WithLabelValues(b.name).Set(float64(len(b.in)))
		case <-ticker.C:
			emit()
		case <-ctx.Done():
			// Stop accepting, then drain what was already accepted.
			b.closeMu.Lock()
			b.closed = true
			b.closeMu.Unlock()
			for drained := false; !drained; {
				select {
				case s := <-b.in:
					add(s)
				default:
					drained = true
				}
			}
			emit()
			close(b.jobs)
			workers.Wait()
			return nil
		}
	}
}

// warnOverloaded logs refused rows at WARN, at most once per
// overloadLogEvery, with the count refused since the previous warning.
func (b *Batcher[T]) warnOverloaded(rows int) {
	b.overloaded.Add(int64(rows))
	now := b.now().UnixNano()
	last := b.overloadLog.Load()
	if last != 0 && now-last < int64(overloadLogEvery) || !b.overloadLog.CompareAndSwap(last, now) {
		return
	}
	b.logger.Warn("sink queue full; rows refused with 503", "rows", b.overloaded.Swap(0), "queue_size", cap(b.in))
}

// flush stores one batch. When the insert still fails after RetryWindow,
// every waiting submission gets the error (the edge answers 503 so the SDKs
// retry) and the rows count as failed; none is reported as stored.
func (b *Batcher[T]) flush(job flushJob[T]) {
	start := b.now()
	attempts, err := b.insertWithRetry(job.rows)
	elapsed := b.now().Sub(start)
	b.metrics.flushDuration.WithLabelValues(b.name).Observe(elapsed.Seconds())
	if err != nil {
		b.metrics.failed.WithLabelValues(b.name).Add(float64(len(job.rows)))
		b.logger.Warn("batch insert failed after retries; rows dropped",
			"rows", len(job.rows), "submissions", len(job.waiters), "attempts", attempts,
			"elapsed", elapsed.Round(time.Millisecond).String(), "error", err)
		err = fmt.Errorf("pipeline: store %s: %w", b.name, err)
	} else {
		b.metrics.stored.WithLabelValues(b.name).Add(float64(len(job.rows)))
	}
	for _, w := range job.waiters {
		w <- err
	}
}

// insertWithRetry inserts rows, retrying with exponential backoff until
// RetryWindow has passed. It returns the attempts made and the last error.
func (b *Batcher[T]) insertWithRetry(rows []T) (int, error) {
	deadline := b.now().Add(b.opts.RetryWindow)
	backoff := retryBackoff
	for attempt := 1; ; attempt++ {
		timeout := b.opts.InsertTimeout
		if left := deadline.Sub(b.now()); attempt > 1 && left < timeout {
			timeout = left
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		err := b.insert(ctx, rows)
		cancel()
		if err == nil {
			return attempt, nil
		}
		left := deadline.Sub(b.now())
		if left <= backoff {
			return attempt, err
		}
		b.logger.Warn("batch insert attempt failed; retrying", "attempt", attempt, "rows", len(rows), "retry_in", backoff.String(), "error", err)
		b.sleep(backoff)
		backoff = min(backoff*2, maxRetryBackoff)
	}
}

// Metrics are shared by all batchers of a sink.
type Metrics struct {
	queued, stored, failed, rejected *prometheus.CounterVec
	depth                            *prometheus.GaugeVec
	flushDuration                    *prometheus.HistogramVec
}

// NewMetrics registers sink metrics on reg (nil skips registration).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		queued:   prometheus.NewCounterVec(prometheus.CounterOpts{Name: "apilens_sink_rows_queued_total", Help: "Rows accepted into the sink."}, []string{"table"}),
		stored:   prometheus.NewCounterVec(prometheus.CounterOpts{Name: "apilens_sink_rows_stored_total", Help: "Rows written to ClickHouse."}, []string{"table"}),
		failed:   prometheus.NewCounterVec(prometheus.CounterOpts{Name: "apilens_sink_rows_failed_total", Help: "Rows not stored because insert retries ran out of their window; with ack=flush their submitters got 503."}, []string{"table"}),
		rejected: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "apilens_sink_rows_rejected_total", Help: "Rows rejected because the queue was full."}, []string{"table"}),
		depth:    prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "apilens_sink_queue_depth", Help: "Submissions waiting in the sink queue."}, []string{"table"}),
		flushDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "apilens_sink_flush_duration_seconds", Help: "Time to store one batch, including retries.",
			Buckets: prometheus.ExponentialBuckets(0.005, 2, 12),
		}, []string{"table"}),
	}
	if reg != nil {
		reg.MustRegister(m.queued, m.stored, m.failed, m.rejected, m.depth, m.flushDuration)
	}
	return m
}
