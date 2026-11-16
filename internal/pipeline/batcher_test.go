package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	promtest "github.com/prometheus/client_golang/prometheus/testutil"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

type recordingInserter struct {
	mu      sync.Mutex
	batches [][]int
	fail    atomic.Int32 // fail this many calls before succeeding
	block   chan struct{}
}

func (r *recordingInserter) insert(_ context.Context, rows []int) error {
	if r.block != nil {
		<-r.block
	}
	if r.fail.Load() > 0 {
		r.fail.Add(-1)
		return errors.New("clickhouse unavailable")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.batches = append(r.batches, append([]int(nil), rows...))
	return nil
}

func (r *recordingInserter) total() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, b := range r.batches {
		n += len(b)
	}
	return n
}

func opts() BatcherOptions {
	return BatcherOptions{BatchSize: 5, FlushInterval: 20 * time.Millisecond, QueueSize: 16, Workers: 1, InsertTimeout: time.Second, RetryWindow: 500 * time.Millisecond, WaitForFlush: true}
}

func start(t *testing.T, b *Batcher[int]) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = b.Run(ctx); close(done) }()
	return func() { cancel(); <-done }
}

func TestGroupCommitFlushesBySizeAndInterval(t *testing.T) {
	rec := &recordingInserter{}
	b := NewBatcher("t", rec.insert, opts(), discard, NewMetrics(nil))
	stop := start(t, b)
	defer stop()

	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := b.Submit(context.Background(), []int{i, i}); err != nil {
				t.Errorf("submit: %v", err)
			}
		}()
	}
	wg.Wait() // returns only after rows are stored (WaitForFlush)
	if rec.total() != 8 {
		t.Fatalf("stored %d rows, want 8", rec.total())
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, batch := range rec.batches {
		if len(batch)%2 != 0 {
			t.Fatalf("a submission was split across batches: %v", rec.batches)
		}
	}
}

func TestRetriesThenSucceeds(t *testing.T) {
	rec := &recordingInserter{}
	rec.fail.Store(2)
	b := NewBatcher("t", rec.insert, opts(), discard, NewMetrics(nil))
	stop := start(t, b)
	defer stop()
	if err := b.Submit(context.Background(), []int{1}); err != nil {
		t.Fatalf("submit: %v", err)
	}
}

func TestExhaustedRetriesReportError(t *testing.T) {
	rec := &recordingInserter{}
	rec.fail.Store(10)
	b := NewBatcher("t", rec.insert, opts(), discard, NewMetrics(nil))
	stop := start(t, b)
	defer stop()
	if err := b.Submit(context.Background(), []int{1}); err == nil {
		t.Fatal("expected an error after retries are exhausted")
	}
}

// fakeClock makes the retry window pass without real sleeping.
type fakeClock struct {
	mu     sync.Mutex
	t      time.Time
	sleeps []time.Duration
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) sleep(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sleeps = append(c.sleeps, d)
	c.t = c.t.Add(d)
}

// TestFailingInserterAnswersEveryWaiterAndCountsDrops (#922): an insert that
// keeps failing is retried with exponential backoff for the whole retry
// window, then every waiting submission gets the error (the edge answers
// 503), the rows count as failed and none as stored.
func TestFailingInserterAnswersEveryWaiterAndCountsDrops(t *testing.T) {
	rec := &recordingInserter{}
	rec.fail.Store(1 << 20)
	o := opts()
	o.RetryWindow = 30 * time.Second
	o.BatchSize = 1000
	o.FlushInterval = 50 * time.Millisecond
	m := NewMetrics(nil)
	b := NewBatcher("t", rec.insert, o, discard, m)
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	b.now, b.sleep = clock.now, clock.sleep
	stop := start(t, b)
	defer stop()

	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = b.Submit(context.Background(), []int{i, i})
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err == nil || !strings.Contains(err.Error(), "clickhouse unavailable") {
			t.Fatalf("submission %d: err = %v, want the insert error", i, err)
		}
	}
	if rec.total() != 0 {
		t.Fatalf("stored %d rows, want 0", rec.total())
	}
	if got := promtest.ToFloat64(m.stored.WithLabelValues("t")); got != 0 {
		t.Fatalf("stored metric = %v, want 0", got)
	}
	if got := promtest.ToFloat64(m.failed.WithLabelValues("t")); got != 6 {
		t.Fatalf("failed metric = %v, want 6", got)
	}

	clock.mu.Lock()
	defer clock.mu.Unlock()
	var total time.Duration
	for i, d := range clock.sleeps {
		total += d
		want := min(retryBackoff<<i, maxRetryBackoff)
		if d != want {
			t.Fatalf("sleep %d = %v, want %v (sleeps %v)", i, d, want, clock.sleeps)
		}
	}
	// The sleeps alone fill the window (inserts take no fake time) and never
	// overrun it.
	if total > o.RetryWindow || total < o.RetryWindow-maxRetryBackoff {
		t.Fatalf("retried for %v, want close to %v (sleeps %v)", total, o.RetryWindow, clock.sleeps)
	}
}

func TestZeroRetryWindowMakesOneAttempt(t *testing.T) {
	var calls atomic.Int32
	o := opts()
	o.RetryWindow = 0
	b := NewBatcher("t", func(context.Context, []int) error {
		calls.Add(1)
		return errors.New("down")
	}, o, discard, NewMetrics(nil))
	stop := start(t, b)
	defer stop()
	if err := b.Submit(context.Background(), []int{1}); err == nil {
		t.Fatal("expected an error")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("attempts = %d, want 1", n)
	}
}

func TestBackpressureReturnsOverloaded(t *testing.T) {
	rec := &recordingInserter{block: make(chan struct{})}
	o := opts()
	o.WaitForFlush = false
	o.QueueSize = 2
	o.BatchSize = 1
	b := NewBatcher("t", rec.insert, o, discard, NewMetrics(nil))
	stop := start(t, b)

	var overloaded bool
	for range 50 {
		if err := b.Submit(context.Background(), []int{1}); errors.Is(err, ErrOverloaded) {
			overloaded = true
			break
		}
	}
	if !overloaded {
		t.Fatal("expected ErrOverloaded while the inserter is blocked")
	}
	if got := promtest.ToFloat64(b.metrics.rejected.WithLabelValues("t")); got < 1 {
		t.Fatalf("rejected metric = %v, want the refused rows counted", got)
	}
	close(rec.block)
	stop()
}

func TestShutdownDrainsAcceptedRows(t *testing.T) {
	rec := &recordingInserter{}
	o := opts()
	o.WaitForFlush = false
	o.FlushInterval = time.Hour // only the shutdown drain can flush
	o.BatchSize = 1000
	b := NewBatcher("t", rec.insert, o, discard, NewMetrics(nil))
	stop := start(t, b)
	for i := range 10 {
		if err := b.Submit(context.Background(), []int{i}); err != nil {
			t.Fatal(err)
		}
	}
	stop()
	if rec.total() != 10 {
		t.Fatalf("stored %d rows after shutdown, want 10", rec.total())
	}
	if err := b.Submit(context.Background(), []int{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("submit after close = %v, want ErrClosed", err)
	}
}
