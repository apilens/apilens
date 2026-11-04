package twofactor

// Managing two-factor authentication once it is on: reading its status,
// turning it off and replacing the backup codes. They back
// GET /api/v1/auth/2fa/status, POST /api/v1/auth/2fa/disable and
// POST /api/v1/auth/2fa/backup-codes/regenerate.
//
// All three need the caller's session to still be current (not revoked, not
// expired): an access token outliving a signed-out session is refused with
// ErrSessionEnded. Disable and Regenerate change what protects the account,
// so on top of that they always need a fresh second factor in the request
// (a code from the authenticator app, or for Disable a backup code): a
// stolen session alone cannot weaken 2FA.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp/totp"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
)

var (
	// ErrNotEnabled means the user's 2FA is not on (never enabled, only
	// pending confirmation, or already turned off).
	ErrNotEnabled = errors.New("twofactor: not enabled")
	// ErrSessionEnded means the caller's session was revoked or has expired.
	ErrSessionEnded = errors.New("twofactor: session ended")
	// ErrProofRequired means a request carried neither or both of a TOTP
	// code and a backup code.
	ErrProofRequired = errors.New("twofactor: exactly one of code and backup code required")
)

// Status is a user's 2FA state.
type Status struct {
	// Enabled reports whether 2FA is on (the secret is confirmed).
	Enabled bool
	// ConfirmedAt is when 2FA was turned on; nil when it is off.
	ConfirmedAt *time.Time
	// BackupCodesRemaining is how many unused backup codes are left; 0 when
	// 2FA is off.
	BackupCodesRemaining int
}

// Proof is the fresh second factor of a Disable request: exactly one of a
// code from the authenticator app and a backup code.
type Proof struct {
	Code       string
	BackupCode string
}

// method names p's factor in audit metadata.
func (p Proof) method() string {
	if p.Code != "" {
		return "totp"
	}
	return "backup_code"
}

// Status returns user's 2FA state, read with session sid.
func (s *Service) Status(ctx context.Context, user, sid uuid.UUID) (Status, error) {
	if _, err := s.currentSession(ctx, user, sid); err != nil {
		return Status{}, err
	}
	row, err := s.q.GetTOTPForUser(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && row.ConfirmedAt == nil {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("twofactor: get secret: %w", err)
	}
	n, err := s.q.CountUnusedBackupCodesForUser(ctx, user)
	if err != nil {
		return Status{}, fmt.Errorf("twofactor: count backup codes: %w", err)
	}
	return Status{Enabled: true, ConfirmedAt: row.ConfirmedAt, BackupCodesRemaining: int(n)}, nil
}

// Disable turns user's 2FA off, signed in with session sid, given a fresh
// code or backup code. It deletes the secret and every backup code, audits
// totp.disabled and enqueues the security_change email, all in one
// transaction. It answers ErrNotEnabled when 2FA is not on and
// ErrInvalidCode for a wrong code or a wrong or spent backup code.
func (s *Service) Disable(ctx context.Context, user, sid uuid.UUID, p Proof) error {
	if (p.Code == "") == (p.BackupCode == "") {
		return ErrProofRequired
	}
	sess, err := s.currentSession(ctx, user, sid)
	if err != nil {
		return err
	}
	u, err := s.user(ctx, user)
	if err != nil {
		return err
	}
	now := s.now()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("twofactor: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	row, err := q.LockConfirmedTOTP(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotEnabled
	}
	if err != nil {
		return fmt.Errorf("twofactor: lock secret: %w", err)
	}
	if p.Code != "" {
		if err := s.checkCode(user, row, p.Code, now); err != nil {
			return err
		}
	} else {
		// Spending the code is moot (all codes go below) but proves it was
		// a valid, unused one.
		_, err := q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: user, CodeHash: HashBackupCode(user, p.BackupCode)})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidCode
		}
		if err != nil {
			return fmt.Errorf("twofactor: use backup code: %w", err)
		}
	}
	if _, err := q.DeleteTOTP(ctx, user); err != nil {
		return fmt.Errorf("twofactor: delete secret: %w", err)
	}
	if _, err := q.DeleteBackupCodesForUser(ctx, user); err != nil {
		return fmt.Errorf("twofactor: delete backup codes: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.TOTPDisabled,
		Meta:  map[string]any{"method": p.method()},
	}); err != nil {
		return err
	}
	if err := s.alert(ctx, tx, u.Email, email.SecurityChangeTOTPDisabled, sess, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("twofactor: commit: %w", err)
	}
	return nil
}

// RegenerateBackupCodes replaces user's backup codes, signed in with
// session sid, given a fresh code from the authenticator app. Every old
// code stops working; the BackupCodeCount new ones are returned, the only
// time they are shown. It enqueues the security_change email in the same
// transaction. It answers ErrNotEnabled when 2FA is not on and
// ErrInvalidCode for a wrong code.
func (s *Service) RegenerateBackupCodes(ctx context.Context, user, sid uuid.UUID, code string) ([]string, error) {
	sess, err := s.currentSession(ctx, user, sid)
	if err != nil {
		return nil, err
	}
	u, err := s.user(ctx, user)
	if err != nil {
		return nil, err
	}
	codes, err := NewBackupCodes()
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(codes))
	hashes := make([]string, len(codes))
	for i, c := range codes {
		ids[i] = uuid.New()
		hashes[i] = HashBackupCode(user, c)
	}
	now := s.now()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("twofactor: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	row, err := q.LockConfirmedTOTP(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotEnabled
	}
	if err != nil {
		return nil, fmt.Errorf("twofactor: lock secret: %w", err)
	}
	if err := s.checkCode(user, row, code, now); err != nil {
		return nil, err
	}
	if _, err := q.DeleteBackupCodesForUser(ctx, user); err != nil {
		return nil, fmt.Errorf("twofactor: delete backup codes: %w", err)
	}
	if _, err := q.CreateBackupCodes(ctx, db.CreateBackupCodesParams{Ids: ids, UserID: user, CodeHashes: hashes}); err != nil {
		return nil, fmt.Errorf("twofactor: store backup codes: %w", err)
	}
	if err := s.alert(ctx, tx, u.Email, email.SecurityChangeBackupCodesReset, sess, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("twofactor: commit: %w", err)
	}
	return codes, nil
}

// currentSession returns user's session sid, or ErrSessionEnded when it is
// gone, revoked or expired.
func (s *Service) currentSession(ctx context.Context, user, sid uuid.UUID) (db.Session, error) {
	sess, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: sid, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Session{}, ErrSessionEnded
	}
	if err != nil {
		return db.Session{}, fmt.Errorf("twofactor: get session: %w", err)
	}
	if sess.RevokedAt != nil || !s.now().Before(sess.ExpiresAt) {
		return db.Session{}, ErrSessionEnded
	}
	return sess, nil
}

// user returns the user, or ErrUserNotFound.
func (s *Service) user(ctx context.Context, user uuid.UUID) (db.User, error) {
	u, err := s.q.GetUserByID(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrUserNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("twofactor: get user: %w", err)
	}
	return u, nil
}

// checkCode validates an authenticator code against row's secret.
func (s *Service) checkCode(user uuid.UUID, row db.UserTotp, code string, now time.Time) error {
	secret, err := s.OpenSecret(user, row.SecretEnc)
	if err != nil {
		return err
	}
	ok, err := totp.ValidateCustom(strings.TrimSpace(code), secret, now, totpOpts)
	if err != nil || !ok {
		return ErrInvalidCode
	}
	return nil
}

// alert enqueues the security_change email for change in tx.
func (s *Service) alert(ctx context.Context, tx pgx.Tx, to, change string, sess db.Session, now time.Time) error {
	device := sess.DeviceLabel
	if device == "" {
		device = "Unknown device"
	}
	ip := ""
	if req := audit.RequestFrom(ctx); req.IP.IsValid() {
		ip = req.IP.String()
	}
	if _, err := s.jobs.InsertTx(ctx, tx, email.SendArgs{
		To:       to,
		Template: email.TemplateSecurityChange,
		Data: map[string]any{
			"change": change,
			"device": device,
			"ip":     ip,
			"time":   now.UTC().Format(time.RFC3339),
		},
	}, nil); err != nil {
		return fmt.Errorf("twofactor: enqueue email: %w", err)
	}
	return nil
}
