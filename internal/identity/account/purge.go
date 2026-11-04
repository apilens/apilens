package account

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// PurgeInterval is how often the purge job runs.
const PurgeInterval = time.Hour

// purgeBatch is how many users one purge transaction removes.
const purgeBatch = 500

// PurgeArgs is the periodic job that hard-deletes users whose grace period
// has passed.
type PurgeArgs struct{}

// Kind is the job kind.
func (PurgeArgs) Kind() string { return "identity.purge_deleted_users" }

// PurgeWorker works PurgeArgs.
type PurgeWorker struct {
	river.WorkerDefaults[PurgeArgs]
	pool   TxBeginner
	logger *slog.Logger
}

// NewPurgeWorker returns the purge worker over pool.
func NewPurgeWorker(pool TxBeginner, logger *slog.Logger) *PurgeWorker {
	return &PurgeWorker{pool: pool, logger: logger}
}

// Work purges every user whose delete_after has passed.
func (w *PurgeWorker) Work(ctx context.Context, _ *river.Job[PurgeArgs]) error {
	n, err := Purge(ctx, w.pool)
	if n > 0 {
		w.logger.InfoContext(ctx, "account: purged deleted users", "users", n)
	}
	return err
}

// Purge hard-deletes every soft-deleted user whose delete_after has passed,
// in batches of purgeBatch, and returns how many it removed. Each batch is
// one transaction: the users' audit events are anonymised (kept, but no
// longer pointing at them, and without IP, user agent or metadata), then the
// users are deleted, which cascades to their sessions, email tokens, OAuth
// identities, passkeys and TOTP rows.
func Purge(ctx context.Context, pool TxBeginner) (int64, error) {
	var total int64
	for {
		n, err := purgeBatchTx(ctx, pool)
		total += n
		if err != nil {
			return total, err
		}
		if n < purgeBatch {
			return total, nil
		}
	}
}

func purgeBatchTx(ctx context.Context, pool TxBeginner) (int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("account: purge: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	ids, err := q.ListPurgeableUsers(ctx, purgeBatch)
	if err != nil {
		return 0, fmt.Errorf("account: purge: list: %w", err)
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if _, err := q.AnonymizeAuditEventsForUsers(ctx, ids); err != nil {
		return 0, fmt.Errorf("account: purge: anonymise audit events: %w", err)
	}
	n, err := q.PurgeUsers(ctx, ids)
	if err != nil {
		return 0, fmt.Errorf("account: purge: delete: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("account: purge: commit: %w", err)
	}
	return n, nil
}
