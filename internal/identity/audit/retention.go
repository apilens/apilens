package audit

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// RetentionInterval is how often the retention job runs.
const RetentionInterval = 24 * time.Hour

// DefaultRetentionBatch is how many events one delete statement removes, so a
// first run over years of events never holds one long transaction.
const DefaultRetentionBatch = 1000

// RetentionOptions configure a Pruner.
type RetentionOptions struct {
	// Days is how long events are kept (audit.retention); 0 keeps them
	// forever and Prune deletes nothing.
	Days int
	// Batch is how many events one statement deletes;
	// DefaultRetentionBatch when <= 0.
	Batch int
	// Now is the clock; time.Now when nil.
	Now func() time.Time
}

// Pruner deletes the audit events older than the retention period.
type Pruner struct {
	q    *db.Queries
	opts RetentionOptions
}

// NewPruner returns a Pruner over conn (usually the pool).
func NewPruner(conn db.DBTX, opts RetentionOptions) *Pruner {
	if opts.Batch <= 0 {
		opts.Batch = DefaultRetentionBatch
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Pruner{q: db.New(conn), opts: opts}
}

// Cutoff returns the time before which events are deleted, and false when
// they are kept forever.
func (p *Pruner) Cutoff() (time.Time, bool) {
	if p.opts.Days <= 0 {
		return time.Time{}, false
	}
	return p.opts.Now().UTC().AddDate(0, 0, -p.opts.Days), true
}

// Prune deletes every event recorded before Cutoff, in batches of
// RetentionOptions.Batch (each its own statement), and returns how many it
// deleted.
func (p *Pruner) Prune(ctx context.Context) (int64, error) {
	cutoff, ok := p.Cutoff()
	if !ok {
		return 0, nil
	}
	var total int64
	for {
		n, err := p.q.DeleteAuditEventsBefore(ctx, db.DeleteAuditEventsBeforeParams{Cutoff: cutoff, BatchSize: int32(p.opts.Batch)})
		total += n
		if err != nil {
			return total, fmt.Errorf("audit: delete events before %s: %w", cutoff.Format(time.RFC3339), err)
		}
		if n < int64(p.opts.Batch) {
			return total, nil
		}
	}
}

// RetentionArgs is the periodic job that deletes expired audit events.
type RetentionArgs struct{}

// Kind is the job kind.
func (RetentionArgs) Kind() string { return "identity.audit_retention" }

// RetentionWorker works RetentionArgs.
type RetentionWorker struct {
	river.WorkerDefaults[RetentionArgs]
	pruner *Pruner
	logger *slog.Logger
}

// NewRetentionWorker returns the retention worker over pruner.
func NewRetentionWorker(pruner *Pruner, logger *slog.Logger) *RetentionWorker {
	return &RetentionWorker{pruner: pruner, logger: logger}
}

// Work deletes the events older than the retention period.
func (w *RetentionWorker) Work(ctx context.Context, _ *river.Job[RetentionArgs]) error {
	n, err := w.pruner.Prune(ctx)
	if n > 0 {
		w.logger.InfoContext(ctx, "audit: deleted expired events", "events", n, "retention_days", w.pruner.opts.Days)
	}
	return err
}
