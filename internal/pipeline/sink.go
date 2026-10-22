package pipeline

import (
	"context"
	"log/slog"
	"sync"

	"github.com/apilens/apilens/internal/platform/config"
)

// Sink accepts validated rows from the edge.
type Sink interface {
	SubmitRequests(ctx context.Context, rows []RequestRow) error
	SubmitLogs(ctx context.Context, rows []LogRow) error
	SubmitSpans(ctx context.Context, rows []SpanRow) error
	SubmitDeploys(ctx context.Context, rows []DeployRow) error
}

// Inserters bundles the per-table writers used by the direct sink.
type Inserters struct {
	Requests Inserter[RequestRow]
	Logs     Inserter[LogRow]
	Spans    Inserter[SpanRow]
	Deploys  Inserter[DeployRow]
}

// DirectSink batches rows in-process and writes them straight to ClickHouse.
type DirectSink struct {
	requests *Batcher[RequestRow]
	logs     *Batcher[LogRow]
	spans    *Batcher[SpanRow]
	deploys  *Batcher[DeployRow]
}

// NewDirectSink builds the sink; Run starts its batchers.
func NewDirectSink(cfg config.SinkConfig, ins Inserters, logger *slog.Logger, m *Metrics) *DirectSink {
	opts := BatcherOptions{
		BatchSize:     cfg.BatchSize,
		FlushInterval: cfg.FlushInterval,
		QueueSize:     cfg.QueueSize,
		Workers:       2,
		InsertTimeout: cfg.InsertTimeout,
		MaxRetries:    cfg.MaxRetries,
		WaitForFlush:  cfg.Ack == "flush",
	}
	small := opts
	small.Workers = 1
	return &DirectSink{
		requests: NewBatcher("api_requests", ins.Requests, opts, logger, m),
		logs:     NewBatcher("api_logs", ins.Logs, opts, logger, m),
		spans:    NewBatcher("api_spans", ins.Spans, opts, logger, m),
		deploys:  NewBatcher("api_deploys", ins.Deploys, small, logger, m),
	}
}

// Run runs all batchers until ctx is cancelled and they have drained.
func (s *DirectSink) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	for _, run := range []func(context.Context) error{s.requests.Run, s.logs.Run, s.spans.Run, s.deploys.Run} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = run(ctx)
		}()
	}
	wg.Wait()
	return nil
}

// SubmitRequests implements Sink.
func (s *DirectSink) SubmitRequests(ctx context.Context, rows []RequestRow) error {
	return s.requests.Submit(ctx, rows)
}

// SubmitLogs implements Sink.
func (s *DirectSink) SubmitLogs(ctx context.Context, rows []LogRow) error {
	return s.logs.Submit(ctx, rows)
}

// SubmitSpans implements Sink.
func (s *DirectSink) SubmitSpans(ctx context.Context, rows []SpanRow) error {
	return s.spans.Submit(ctx, rows)
}

// SubmitDeploys implements Sink.
func (s *DirectSink) SubmitDeploys(ctx context.Context, rows []DeployRow) error {
	return s.deploys.Submit(ctx, rows)
}
