package apikeys

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
)

// ExpiryInterval is how often the API key expiry job runs.
const ExpiryInterval = time.Hour

// ExpiryReminderWindow is how long before a key expires its project admins
// are reminded.
const ExpiryReminderWindow = 7 * 24 * time.Hour

// expiryBatch is how many keys one expiry transaction handles.
const expiryBatch = 200

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Enqueuer inserts jobs inside a transaction; *jobs.Client satisfies it.
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// Expiry tells project admins about keys that are about to expire and
// records keys that have expired (#799).
//
// For every active key that expires within ExpiryReminderWindow it emails
// the project admins once (api_key_expiring, skipped for admins who turned
// off the security_emails preference) and sets expiry_notified_at. For
// every key whose expires_at has passed it writes api_key.expired once,
// with no actor, and sets expired_recorded_at. Revoked keys, keys of
// deleted projects and rotated keys (rotated_to set: the rotation already
// says when the old secret stops) get neither. Each batch is one
// transaction, so the emails are enqueued and the event written only if
// the key is marked in the same commit.
type Expiry struct {
	pool   TxBeginner
	audit  Auditor
	jobs   Enqueuer
	logger *slog.Logger
	now    func() time.Time
}

// NewExpiry returns the expiry job logic over pool, writing audit events
// with auditor and enqueuing emails on jobs.
func NewExpiry(pool TxBeginner, auditor Auditor, jobs Enqueuer, logger *slog.Logger) *Expiry {
	return &Expiry{pool: pool, audit: auditor, jobs: jobs, logger: logger, now: time.Now}
}

// WithClock replaces the clock (tests). It returns e.
func (e *Expiry) WithClock(now func() time.Time) *Expiry {
	e.now = now
	return e
}

// ExpiryResult counts what one Run did.
type ExpiryResult struct {
	Reminded int // keys whose admins were reminded
	Emails   int // reminder emails enqueued
	Expired  int // api_key.expired events written
}

// Run reminds and records every key that is due, in batches.
func (e *Expiry) Run(ctx context.Context) (ExpiryResult, error) {
	var res ExpiryResult
	now := e.now().UTC()
	for {
		n, err := e.expiredBatch(ctx, now, &res)
		if err != nil {
			return res, err
		}
		if n < expiryBatch {
			break
		}
	}
	for {
		n, err := e.reminderBatch(ctx, now, &res)
		if err != nil {
			return res, err
		}
		if n < expiryBatch {
			break
		}
	}
	return res, nil
}

func (e *Expiry) reminderBatch(ctx context.Context, now time.Time, res *ExpiryResult) (int, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("apikeys: expiry: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	keys, err := q.LockAPIKeysExpiringSoon(ctx, db.LockAPIKeysExpiringSoonParams{
		Now: now, Until: now.Add(ExpiryReminderWindow), Batch: expiryBatch,
	})
	if err != nil {
		return 0, fmt.Errorf("apikeys: expiry: list expiring keys: %w", err)
	}
	if len(keys) == 0 {
		return 0, nil
	}
	admins := map[uuid.UUID][]db.ListProjectAdminRecipientsRow{}
	reminded, emails := 0, 0
	for _, k := range keys {
		recipients, ok := admins[k.ProjectID]
		if !ok {
			if recipients, err = q.ListProjectAdminRecipients(ctx, k.ProjectID); err != nil {
				return 0, fmt.Errorf("apikeys: expiry: list admins: %w", err)
			}
			admins[k.ProjectID] = recipients
		}
		for _, a := range recipients {
			if !a.SecurityEmails {
				continue
			}
			args := email.SendArgs{To: a.Email, Template: email.TemplateAPIKeyExpiring, Data: map[string]any{
				"project":    a.ProjectName,
				"slug":       a.ProjectSlug,
				"key":        k.Name,
				"prefix":     k.Prefix,
				"expires_at": k.ExpiresAt.UTC().Format(time.RFC3339),
			}}
			if _, err := e.jobs.InsertTx(ctx, tx, args, nil); err != nil {
				return 0, fmt.Errorf("apikeys: expiry: enqueue reminder: %w", err)
			}
			emails++
		}
		if err := q.MarkAPIKeyExpiryNotified(ctx, db.MarkAPIKeyExpiryNotifiedParams{ID: k.ID, At: now}); err != nil {
			return 0, fmt.Errorf("apikeys: expiry: mark reminded: %w", err)
		}
		reminded++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("apikeys: expiry: commit: %w", err)
	}
	res.Reminded += reminded
	res.Emails += emails
	return len(keys), nil
}

func (e *Expiry) expiredBatch(ctx context.Context, now time.Time, res *ExpiryResult) (int, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("apikeys: expiry: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	keys, err := q.LockAPIKeysExpiredUnrecorded(ctx, db.LockAPIKeysExpiredUnrecordedParams{Now: now, Batch: expiryBatch})
	if err != nil {
		return 0, fmt.Errorf("apikeys: expiry: list expired keys: %w", err)
	}
	if len(keys) == 0 {
		return 0, nil
	}
	actx := audit.WithTx(ctx, tx)
	for _, k := range keys {
		if err := e.audit.Record(actx, audit.Event{
			Kind:    audit.APIKeyExpired,
			Org:     &k.OrgID,
			Project: &k.ProjectID,
			Target:  keyTarget(k.ID, k.Name),
			Meta: map[string]any{
				"org_id":       k.OrgID.String(),
				"project_id":   k.ProjectID.String(),
				"project_slug": k.ProjectSlug,
				"key_id":       k.ID.String(),
				"name":         k.Name,
				"prefix":       k.Prefix,
				"scopes":       k.Scopes,
				"expires_at":   k.ExpiresAt.UTC(),
			},
		}); err != nil {
			return 0, fmt.Errorf("apikeys: expiry: audit: %w", err)
		}
		if err := q.MarkAPIKeyExpiredRecorded(ctx, db.MarkAPIKeyExpiredRecordedParams{ID: k.ID, At: now}); err != nil {
			return 0, fmt.Errorf("apikeys: expiry: mark expired: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("apikeys: expiry: commit: %w", err)
	}
	res.Expired += len(keys)
	return len(keys), nil
}

// ExpiryArgs is the periodic API key expiry job.
type ExpiryArgs struct{}

// Kind is the job kind.
func (ExpiryArgs) Kind() string { return "apikeys.expiry" }

// ExpiryWorker works ExpiryArgs.
type ExpiryWorker struct {
	river.WorkerDefaults[ExpiryArgs]
	expiry *Expiry
}

// NewExpiryWorker returns the worker that runs e.
func NewExpiryWorker(e *Expiry) *ExpiryWorker { return &ExpiryWorker{expiry: e} }

// Work reminds and records every key that is due.
func (w *ExpiryWorker) Work(ctx context.Context, _ *river.Job[ExpiryArgs]) error {
	res, err := w.expiry.Run(ctx)
	if res.Reminded > 0 || res.Expired > 0 {
		w.expiry.logger.InfoContext(ctx, "apikeys: expiry reminders and events",
			"reminded", res.Reminded, "emails", res.Emails, "expired", res.Expired)
	}
	return err
}
