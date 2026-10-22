package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	return BatcherOptions{BatchSize: 5, FlushInterval: 20 * time.Millisecond, QueueSize: 16, Workers: 1, InsertTimeout: time.Second, MaxRetries: 2, WaitForFlush: true}
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
