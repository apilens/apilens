// Package recovery lets a user who lost their two-factor device get back
// into their account by email, after a cooling-off period. It backs
// POST /api/v1/auth/recovery/request, GET /api/v1/auth/recovery/status,
// POST /api/v1/auth/recovery/confirm and POST /api/v1/auth/recovery/cancel.
//
// The flow:
//
//  1. Request, given an email address, stores a recovery request for the
//     active account with that address and two-factor authentication on,
//     and emails recovery_requested with a cancel link carrying a fresh
//     random token. Only the token's SHA-256 is stored. An address with no
//     such account gets no email and the same answer, so a request reveals
//     nothing. A new request cancels the user's older pending ones.
//  2. The request becomes ready Delay (identity.recovery_delay, 24 h) after
//     it was made. Until then it can only be cancelled: inbox access alone
//     is not enough to remove 2FA, and the account owner has a day to
//     notice the email and cancel.
//  3. Confirm, once ready, turns 2FA off (deletes the TOTP secret and every
//     backup code), revokes every session, audits recovery.confirmed and
//     totp.disabled and enqueues the security_change email
//     (recovery_completed), all in one transaction. The caller then starts
//     a fresh session for the returned user.
//
// Every time comes from Options.Now, so tests drive the cooling-off period
// with a fake clock.
package recovery

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// DefaultDelay is the cooling-off period when Options.Delay is unset.
const DefaultDelay = 24 * time.Hour

// tokenBytes is the entropy of a recovery token (256 bits).
const tokenBytes = 32

// maxTokenLen bounds the raw token accepted for hashing; a valid one is 43
// characters.
const maxTokenLen = 128

var (
	// ErrInvalidToken means the token is malformed or unknown, or its
	// request was already confirmed or cancelled, or its user is gone.
	ErrInvalidToken = errors.New("recovery: invalid token")
	// ErrNotReady means the request is pending but its cooling-off period
	// has not passed. It is returned as a *NotReadyError.
	ErrNotReady = errors.New("recovery: not ready")
)

// NotReadyError is the ErrNotReady of a request that becomes ready at
// ReadyAt, Wait from now.
type NotReadyError struct {
	ReadyAt time.Time
	Wait    time.Duration
}

func (e *NotReadyError) Error() string {
	return fmt.Sprintf("recovery: not ready until %s", e.ReadyAt.UTC().Format(time.RFC3339))
}

// Is makes errors.Is(err, ErrNotReady) match.
func (e *NotReadyError) Is(target error) bool { return target == ErrNotReady }

// State is where a recovery request is in its life.
type State string

// The states of a recovery request.
const (
	// StatePending: waiting out the cooling-off period.
	StatePending State = "pending"
	// StateReady: the cooling-off period has passed; it can be confirmed.
	StateReady State = "ready"
	// StateConfirmed: recovery completed.
	StateConfirmed State = "confirmed"
	// StateCancelled: cancelled, or replaced by a newer request.
	StateCancelled State = "cancelled"
)

// Status describes a recovery request.
type Status struct {
	State       State
	RequestedAt time.Time
	ReadyAt     time.Time
}

// Enqueuer enqueues background jobs in a transaction; *jobs.Client
// satisfies it.
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Options configures a Service.
type Options struct {
	// Delay is the cooling-off period (identity.recovery_delay). Zero means
	// DefaultDelay.
	Delay time.Duration
	// Now returns the current time. Nil means time.Now.
	Now func() time.Time
}

// Service runs account recovery.
type Service struct {
	pool  TxBeginner
	q     *db.Queries
	audit *audit.Recorder
	jobs  Enqueuer
	delay time.Duration
	now   func() time.Time
}

// New returns a Service over pool that enqueues emails on jobs.
func New(pool TxBeginner, jobs Enqueuer, opts Options) *Service {
	if opts.Delay <= 0 {
		opts.Delay = DefaultDelay
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{pool: pool, q: db.New(pool), audit: audit.New(pool), jobs: jobs, delay: opts.Delay, now: opts.Now}
}

// Request starts recovery for the active account with address addr (already
// normalized), when it has two-factor authentication on. Otherwise it does
// nothing and still returns nil, so the caller's answer is the same either
// way.
func (s *Service) Request(ctx context.Context, addr string) error {
	u, err := s.q.GetUserByEmail(ctx, addr)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("recovery: look up user: %w", err)
	}
	totp, err := s.q.GetTOTPForUser(ctx, u.ID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && totp.ConfirmedAt == nil {
		return nil
	}
	if err != nil {
		return fmt.Errorf("recovery: load totp: %w", err)
	}

	raw, hash, err := newToken()
	if err != nil {
		return err
	}
	now := s.now()
	req := audit.RequestFrom(ctx)
	params := db.CreateRecoveryRequestParams{
		ID:          uuid.New(),
		UserID:      u.ID,
		TokenHash:   hash,
		RequestedAt: now,
		ReadyAt:     now.Add(s.delay),
		UserAgent:   req.UserAgent,
	}
	ip := "unknown"
	if req.IP.IsValid() {
		a := req.IP
		params.Ip = &a
		ip = a.String()
	}

	return s.inTx(ctx, func(ctx context.Context, tx pgx.Tx, q *db.Queries) error {
		// Only the newest request works.
		if _, err := q.CancelPendingRecoveryRequestsForUser(ctx, db.CancelPendingRecoveryRequestsForUserParams{Now: now, UserID: u.ID}); err != nil {
			return fmt.Errorf("recovery: cancel older requests: %w", err)
		}
		row, err := q.CreateRecoveryRequest(ctx, params)
		if err != nil {
			return fmt.Errorf("recovery: create request: %w", err)
		}
		if err := s.audit.Record(ctx, audit.Event{
			User: &u.ID,
			Kind: audit.RecoveryRequested,
			Meta: map[string]any{"request_id": row.ID.String(), "ready_at": row.ReadyAt.UTC().Format(time.RFC3339)},
		}); err != nil {
			return err
		}
		if _, err := s.jobs.InsertTx(ctx, tx, email.SendArgs{
			To:       u.Email,
			Template: email.TemplateRecoveryRequested,
			Data: map[string]any{
				"token":    raw,
				"ip":       ip,
				"time":     now.UTC().Format(time.RFC3339),
				"ready_at": row.ReadyAt.UTC().Format(time.RFC3339),
			},
		}, nil); err != nil {
			return fmt.Errorf("recovery: enqueue email: %w", err)
		}
		return nil
	})
}

// Status returns the state of the request of token.
func (s *Service) Status(ctx context.Context, token string) (Status, error) {
	row, err := s.lookup(ctx, s.q, token)
	if err != nil {
		return Status{}, err
	}
	st := Status{RequestedAt: row.RequestedAt, ReadyAt: row.ReadyAt}
	switch {
	case row.ConfirmedAt != nil:
		st.State = StateConfirmed
	case row.CancelledAt != nil:
		st.State = StateCancelled
	case s.now().Before(row.ReadyAt):
		st.State = StatePending
	default:
		st.State = StateReady
	}
	return st, nil
}

// Confirm completes the ready request of token: it turns the user's 2FA
// off, revokes all their sessions, audits and enqueues the security_change
// email, and returns the user for a fresh session. A pending request that
// is not ready yet answers a *NotReadyError (ErrNotReady); an unknown,
// confirmed or cancelled one ErrInvalidToken.
func (s *Service) Confirm(ctx context.Context, token string) (db.User, error) {
	var user db.User
	err := s.inTx(ctx, func(ctx context.Context, tx pgx.Tx, q *db.Queries) error {
		row, err := s.lookup(ctx, q, token)
		if err != nil {
			return err
		}
		if row.ConfirmedAt != nil || row.CancelledAt != nil {
			return ErrInvalidToken
		}
		now := s.now()
		if now.Before(row.ReadyAt) {
			return &NotReadyError{ReadyAt: row.ReadyAt, Wait: row.ReadyAt.Sub(now)}
		}
		user, err = q.GetUserByID(ctx, row.UserID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidToken
		}
		if err != nil {
			return fmt.Errorf("recovery: get user: %w", err)
		}
		// Of two concurrent confirms only one gets the row.
		if _, err := q.ConfirmRecoveryRequest(ctx, db.ConfirmRecoveryRequestParams{Now: now, ID: row.ID}); errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidToken
		} else if err != nil {
			return fmt.Errorf("recovery: confirm: %w", err)
		}
		totpDeleted, err := q.DeleteTOTP(ctx, user.ID)
		if err != nil {
			return fmt.Errorf("recovery: delete totp: %w", err)
		}
		if _, err := q.DeleteBackupCodesForUser(ctx, user.ID); err != nil {
			return fmt.Errorf("recovery: delete backup codes: %w", err)
		}
		revoked, err := q.RevokeAllForUser(ctx, db.RevokeAllForUserParams{UserID: user.ID, Reason: session.ReasonRecovered})
		if err != nil {
			return fmt.Errorf("recovery: revoke sessions: %w", err)
		}
		if err := s.audit.Record(ctx, audit.Event{
			User:  &user.ID,
			Actor: &user.ID,
			Kind:  audit.RecoveryConfirmed,
			Meta:  map[string]any{"request_id": row.ID.String(), "sessions_revoked": revoked},
		}); err != nil {
			return err
		}
		if totpDeleted > 0 {
			if err := s.audit.Record(ctx, audit.Event{
				User:  &user.ID,
				Actor: &user.ID,
				Kind:  audit.TOTPDisabled,
				Meta:  map[string]any{"method": "recovery"},
			}); err != nil {
				return err
			}
		}
		req := audit.RequestFrom(ctx)
		ip := "unknown"
		if req.IP.IsValid() {
			ip = req.IP.String()
		}
		if _, err := s.jobs.InsertTx(ctx, tx, email.SendArgs{
			To:       user.Email,
			Template: email.TemplateSecurityChange,
			Data: map[string]any{
				"change": email.SecurityChangeRecoveryCompleted,
				"device": session.DeviceLabel(req.UserAgent),
				"ip":     ip,
				"time":   now.UTC().Format(time.RFC3339),
			},
		}, nil); err != nil {
			return fmt.Errorf("recovery: enqueue email: %w", err)
		}
		return nil
	})
	if err != nil {
		return db.User{}, err
	}
	return user, nil
}

// Cancel cancels the pending request of token and audits
// recovery.cancelled. Cancelling an already cancelled request succeeds and
// changes nothing; a confirmed or unknown one answers ErrInvalidToken.
func (s *Service) Cancel(ctx context.Context, token string) error {
	return s.inTx(ctx, func(ctx context.Context, _ pgx.Tx, q *db.Queries) error {
		row, err := s.lookup(ctx, q, token)
		if err != nil {
			return err
		}
		switch {
		case row.ConfirmedAt != nil:
			return ErrInvalidToken
		case row.CancelledAt != nil:
			return nil
		}
		if _, err := q.CancelRecoveryRequest(ctx, db.CancelRecoveryRequestParams{Now: s.now(), ID: row.ID}); errors.Is(err, pgx.ErrNoRows) {
			// Confirmed or cancelled concurrently: report what happened.
			return s.settled(ctx, q, row.TokenHash)
		} else if err != nil {
			return fmt.Errorf("recovery: cancel: %w", err)
		}
		return s.audit.Record(ctx, audit.Event{
			User:  &row.UserID,
			Actor: &row.UserID,
			Kind:  audit.RecoveryCancelled,
			Meta:  map[string]any{"request_id": row.ID.String()},
		})
	})
}

// settled re-reads a request that stopped being pending under Cancel: nil
// when it ended cancelled, ErrInvalidToken when it was confirmed.
func (s *Service) settled(ctx context.Context, q *db.Queries, hash string) error {
	row, err := q.GetRecoveryRequestByTokenHash(ctx, hash)
	if err != nil {
		return fmt.Errorf("recovery: reload: %w", err)
	}
	if row.ConfirmedAt != nil {
		return ErrInvalidToken
	}
	return nil
}

// lookup returns the request of token, or ErrInvalidToken.
func (s *Service) lookup(ctx context.Context, q *db.Queries, token string) (db.RecoveryRequest, error) {
	if token == "" || len(token) > maxTokenLen {
		return db.RecoveryRequest{}, ErrInvalidToken
	}
	row, err := q.GetRecoveryRequestByTokenHash(ctx, Hash(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return db.RecoveryRequest{}, ErrInvalidToken
	}
	if err != nil {
		return db.RecoveryRequest{}, fmt.Errorf("recovery: get request: %w", err)
	}
	return row, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (s *Service) inTx(ctx context.Context, fn func(context.Context, pgx.Tx, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("recovery: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), tx, s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("recovery: commit: %w", err)
	}
	return nil
}

// newToken returns a fresh raw token and its stored hash.
func newToken() (raw, hash string, err error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("recovery: token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, Hash(raw), nil
}

// Hash is the stored form of a recovery token: hex SHA-256.
func Hash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
