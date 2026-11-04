// Package emailchange changes the signed-in user's email address after the
// new address proves it can receive mail. It backs
// POST /api/v1/users/me/email/change and /confirm.
//
//  1. Start checks the new address is free, retires the user's older pending
//     change, issues a change_email code to the new address (emailauth) and
//     enqueues the email_change email with it.
//  2. Confirm finds the user's pending change, checks the code against it
//     (wrong guesses count towards emailauth.MaxAttempts), then in one
//     transaction swaps the email (marking it verified), signs out every
//     other session, retires outstanding emails to the old address, audits
//     email.changed and enqueues a security_change alert to the old address.
//
// Whether an address is taken (ErrEmailTaken) is only revealed here, to an
// authenticated user changing their own email.
package emailchange

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
)

var (
	// ErrNotFound means the user (or the current session) no longer exists.
	ErrNotFound = errors.New("emailchange: user not found")
	// ErrEmailTaken means another active account uses the new address.
	ErrEmailTaken = errors.New("emailchange: email taken")
	// ErrSameEmail means the new address is the current one.
	ErrSameEmail = errors.New("emailchange: same email")
)

// Codes issues and verifies email codes; *emailauth.Service satisfies it.
type Codes interface {
	Issue(ctx context.Context, email string, intent emailauth.Intent, opts emailauth.IssueOptions) (emailauth.Issued, error)
	VerifyCode(ctx context.Context, email, code string) (db.AuthEmailToken, error)
}

// Enqueuer enqueues background jobs; *jobs.Client satisfies it.
type Enqueuer interface {
	Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service starts and confirms email changes.
type Service struct {
	pool  TxBeginner
	q     *db.Queries
	codes Codes
	jobs  Enqueuer
	audit *audit.Recorder
	now   func() time.Time
}

// New returns a Service over pool that issues codes with codes and sends
// email through jobs.
func New(pool TxBeginner, codes Codes, jobs Enqueuer) *Service {
	return &Service{pool: pool, q: db.New(pool), codes: codes, jobs: jobs, audit: audit.New(pool), now: time.Now}
}

// Pending is a started email change.
type Pending struct {
	// Email is the new address the code was sent to.
	Email string
	// ExpiresAt is when the code stops working.
	ExpiresAt time.Time
}

// Start sends a change_email code to newEmail for user id. It refuses with
// ErrSameEmail when newEmail is the current address and ErrEmailTaken when
// another active account has it. An older pending change of the user stops
// working.
func (s *Service) Start(ctx context.Context, id uuid.UUID, newEmail string) (Pending, error) {
	newEmail = strings.TrimSpace(newEmail)
	u, err := s.q.GetUserByID(ctx, id)
	if err != nil {
		return Pending{}, notFound(err, "get user")
	}
	if strings.EqualFold(u.Email, newEmail) {
		return Pending{}, ErrSameEmail
	}
	switch _, err := s.q.GetUserByEmail(ctx, newEmail); {
	case err == nil:
		return Pending{}, ErrEmailTaken
	case !errors.Is(err, pgx.ErrNoRows):
		return Pending{}, fmt.Errorf("emailchange: lookup email: %w", err)
	}
	if _, err := s.q.InvalidateEmailTokensForUser(ctx, db.InvalidateEmailTokensForUserParams{
		UserID: &id, Intent: string(emailauth.IntentChangeEmail),
	}); err != nil {
		return Pending{}, fmt.Errorf("emailchange: retire pending: %w", err)
	}
	req := audit.RequestFrom(ctx)
	opts := emailauth.IssueOptions{UserID: &id, UserAgent: req.UserAgent}
	if req.IP.IsValid() {
		ip := req.IP
		opts.IP = &ip
	}
	issued, err := s.codes.Issue(ctx, newEmail, emailauth.IntentChangeEmail, opts)
	if err != nil {
		return Pending{}, fmt.Errorf("emailchange: issue: %w", err)
	}
	job := email.SendArgs{To: newEmail, Template: email.TemplateEmailChange, Data: map[string]any{
		"code":       issued.Code,
		"expires_in": fmt.Sprintf("%d minutes", int(emailauth.TTL/time.Minute)),
	}}
	if _, err := s.jobs.Insert(ctx, job, nil); err != nil {
		return Pending{}, fmt.Errorf("emailchange: enqueue email: %w", err)
	}
	return Pending{Email: issued.Row.Email, ExpiresAt: issued.Row.ExpiresAt}, nil
}

// Confirm checks code against user id's pending email change and, when it
// matches, makes the new address the user's (verified) email, revokes every
// session outside currentSession's family, audits email.changed and alerts
// the old address.
//
// It returns emailauth.ErrInvalidCode when there is no pending change or the
// code is wrong, emailauth.ErrCodeExpired and emailauth.ErrTooManyAttempts as
// emailauth does, and ErrEmailTaken when the address was taken since Start.
func (s *Service) Confirm(ctx context.Context, id, currentSession uuid.UUID, code string) (db.User, error) {
	old, err := s.q.GetUserByID(ctx, id)
	if err != nil {
		return db.User{}, notFound(err, "get user")
	}
	sess, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: currentSession, UserID: id})
	if err != nil {
		return db.User{}, notFound(err, "get session")
	}
	pending, err := s.q.GetLatestUnconsumedEmailTokenForUser(ctx, db.GetLatestUnconsumedEmailTokenForUserParams{
		UserID: &id, Intent: string(emailauth.IntentChangeEmail),
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return db.User{}, emailauth.ErrInvalidCode
	case err != nil:
		return db.User{}, fmt.Errorf("emailchange: get pending: %w", err)
	}
	row, err := s.codes.VerifyCode(ctx, pending.Email, code)
	if err != nil {
		return db.User{}, err
	}
	if row.ID != pending.ID {
		// The code belongs to a newer email to the same address (a
		// sign-in, say), not to this user's change.
		return db.User{}, emailauth.ErrInvalidCode
	}

	var user db.User
	err = s.inTx(ctx, func(ctx context.Context, tx pgx.Tx, q *db.Queries) error {
		user, err = q.UpdateUserEmail(ctx, db.UpdateUserEmailParams{ID: id, Email: row.Email})
		if err != nil {
			if isEmailConflict(err) {
				return ErrEmailTaken
			}
			return notFound(err, "update email")
		}
		n, err := q.RevokeOthersForUser(ctx, db.RevokeOthersForUserParams{
			UserID: id, KeepFamilyID: sess.FamilyID, Reason: session.ReasonEmailChanged,
		})
		if err != nil {
			return fmt.Errorf("emailchange: revoke sessions: %w", err)
		}
		if _, err := q.InvalidateEmailTokensForEmail(ctx, old.Email); err != nil {
			return fmt.Errorf("emailchange: retire old address emails: %w", err)
		}
		if err := s.audit.Record(ctx, audit.Event{
			User:  &id,
			Actor: &id,
			Kind:  audit.EmailChanged,
			Meta:  map[string]any{"sessions_revoked": n},
		}); err != nil {
			return err
		}
		_, err = s.jobs.InsertTx(ctx, tx, s.alert(ctx, old.Email, sess), nil)
		if err != nil {
			return fmt.Errorf("emailchange: enqueue alert: %w", err)
		}
		return nil
	})
	if err != nil {
		return db.User{}, err
	}
	return user, nil
}

// alert is the security_change email telling the old address about the
// change, with the device and IP it was made from.
func (s *Service) alert(ctx context.Context, to string, sess db.Session) email.SendArgs {
	req := audit.RequestFrom(ctx)
	device := sess.DeviceLabel
	if device == "" {
		device = req.UserAgent
	}
	if device == "" {
		device = "Unknown device"
	}
	ip := "Unknown"
	if req.IP.IsValid() {
		ip = req.IP.String()
	}
	return email.SendArgs{To: to, Template: email.TemplateSecurityChange, Data: map[string]any{
		"change": email.SecurityChangeEmailChanged,
		"device": device,
		"ip":     ip,
		"time":   s.now().UTC(),
	}}
}

// inTx runs fn in a transaction whose audit events and jobs commit with it.
func (s *Service) inTx(ctx context.Context, fn func(context.Context, pgx.Tx, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("emailchange: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), tx, s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("emailchange: commit: %w", err)
	}
	return nil
}

// isEmailConflict reports whether err is the unique violation of an active
// user's email (users_email_active).
func isEmailConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func notFound(err error, op string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return fmt.Errorf("emailchange: %s: %w", op, err)
}
