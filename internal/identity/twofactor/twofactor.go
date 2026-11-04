// Package twofactor turns TOTP two-factor authentication on for a user and
// hands out backup codes. It backs POST /api/v1/auth/2fa/enable and
// POST /api/v1/auth/2fa/verify; manage.go backs status, disable and backup
// code regeneration.
//
// Enabling is two steps:
//
//  1. Enable generates a TOTP secret (issuer "APILens", the user's email as
//     the account name) and stores it unconfirmed, encrypted with the
//     identity key encryption key. It needs a recent sign-in (RecentSignIn):
//     a stolen, long-lived session cannot attach an attacker's
//     authenticator. Enabling again before confirming replaces the pending
//     secret; once confirmed it answers ErrAlreadyEnabled.
//  2. Verify checks a code from the authenticator app against the pending
//     secret (one period of skew either way), marks it confirmed, stores
//     BackupCodeCount fresh backup codes as hashes and returns the raw codes,
//     the only time they are ever shown. It audits totp.enabled and enqueues
//     the security_change email in the same transaction.
//
// The base32 secret is never stored in the clear: user_totp.secret_enc is
// AES-256-GCM ciphertext whose additional data is the user id, so a
// ciphertext copied onto another user's row fails to open. Backup codes are
// stored as HashBackupCode, salted with the user id.
package twofactor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// Issuer names APILens in authenticator apps (the otpauth URI's issuer).
const Issuer = "APILens"

// RecentSignIn is how long after signing in a session may enable 2FA.
const RecentSignIn = 10 * time.Minute

// BackupCodeCount is how many backup codes a confirmation hands out.
const BackupCodeCount = 10

// Skew is how many 30-second periods before or after now a code may be from.
const Skew = 1

// backupCodeAlphabet is lowercase RFC 4648 base32: it has no 0 or 1, so a
// code copied by hand cannot confuse them with o and l. 32 symbols, 5 bits
// each.
const backupCodeAlphabet = "abcdefghijklmnopqrstuvwxyz234567"

// backupCodeHalf is the length of each half of an xxxx-xxxx code (40 bits).
const backupCodeHalf = 4

// totpOpts are the parameters of every APILens secret: the defaults Google
// Authenticator and every other app support.
var totpOpts = totp.ValidateOpts{Period: 30, Skew: Skew, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1}

var (
	// ErrAlreadyEnabled means the user's 2FA is already confirmed.
	ErrAlreadyEnabled = errors.New("twofactor: already enabled")
	// ErrReauthRequired means the session signed in more than RecentSignIn
	// ago (or has ended); the user must sign in again.
	ErrReauthRequired = errors.New("twofactor: recent sign-in required")
	// ErrNotPending means Verify was called with no pending secret: enable
	// was never started.
	ErrNotPending = errors.New("twofactor: no pending secret")
	// ErrInvalidCode means the code does not match the pending secret.
	ErrInvalidCode = errors.New("twofactor: invalid code")
	// ErrUserNotFound means the user does not exist or is deleted.
	ErrUserNotFound = errors.New("twofactor: user not found")
)

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

// Service enables two-factor authentication.
type Service struct {
	pool   TxBeginner
	q      *db.Queries
	sealer *keys.Sealer
	audit  *audit.Recorder
	jobs   Enqueuer
	now    func() time.Time
}

// New returns a Service over pool that encrypts secrets with kek (the
// 32-byte identity key encryption key) and enqueues security emails on jobs.
func New(pool TxBeginner, kek []byte, jobs Enqueuer) (*Service, error) {
	sealer, err := keys.NewSealer(kek)
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, q: db.New(pool), sealer: sealer, audit: audit.New(pool), jobs: jobs, now: time.Now}, nil
}

// Enrollment is a freshly generated, unconfirmed TOTP secret.
type Enrollment struct {
	// Secret is the base32 secret, for typing into an authenticator app.
	Secret string
	// URI is the otpauth:// key URI, for rendering as a QR code.
	URI string
}

// Enable generates and stores a pending TOTP secret for user, signed in
// with session sid. It answers ErrReauthRequired when that sign-in is older
// than RecentSignIn and ErrAlreadyEnabled when 2FA is already confirmed.
func (s *Service) Enable(ctx context.Context, user, sid uuid.UUID) (Enrollment, error) {
	sess, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: sid, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return Enrollment{}, ErrReauthRequired
	}
	if err != nil {
		return Enrollment{}, fmt.Errorf("twofactor: get session: %w", err)
	}
	now := s.now()
	if sess.RevokedAt != nil || !now.Before(sess.ExpiresAt) || now.Sub(sess.CreatedAt) > RecentSignIn {
		return Enrollment{}, ErrReauthRequired
	}
	u, err := s.q.GetUserByID(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return Enrollment{}, ErrUserNotFound
	}
	if err != nil {
		return Enrollment{}, fmt.Errorf("twofactor: get user: %w", err)
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      Issuer,
		AccountName: u.Email,
		Period:      totpOpts.Period,
		Digits:      totpOpts.Digits,
		Algorithm:   totpOpts.Algorithm,
	})
	if err != nil {
		return Enrollment{}, fmt.Errorf("twofactor: generate secret: %w", err)
	}
	sealed, err := s.SealSecret(user, key.Secret())
	if err != nil {
		return Enrollment{}, err
	}
	_, err = s.q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: user, SecretEnc: sealed})
	if errors.Is(err, pgx.ErrNoRows) {
		return Enrollment{}, ErrAlreadyEnabled
	}
	if err != nil {
		return Enrollment{}, fmt.Errorf("twofactor: store secret: %w", err)
	}
	return Enrollment{Secret: key.Secret(), URI: key.URL()}, nil
}

// Verify confirms user's pending secret with code from the authenticator
// app, signed in with session sid (for the alert email's device). On success
// it returns BackupCodeCount backup codes, which are never retrievable
// again.
func (s *Service) Verify(ctx context.Context, user, sid uuid.UUID, code string) ([]string, error) {
	row, err := s.q.GetTOTPForUser(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotPending
	}
	if err != nil {
		return nil, fmt.Errorf("twofactor: get secret: %w", err)
	}
	if row.ConfirmedAt != nil {
		return nil, ErrAlreadyEnabled
	}
	secret, err := s.OpenSecret(user, row.SecretEnc)
	if err != nil {
		return nil, err
	}
	now := s.now()
	ok, err := totp.ValidateCustom(strings.TrimSpace(code), secret, now, totpOpts)
	if err != nil || !ok {
		return nil, ErrInvalidCode
	}
	u, err := s.q.GetUserByID(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("twofactor: get user: %w", err)
	}
	device := "Unknown device"
	if sess, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: sid, UserID: user}); err == nil && sess.DeviceLabel != "" {
		device = sess.DeviceLabel
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

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("twofactor: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	// Of two concurrent confirmations only one gets the row; the other was
	// beaten to it, so 2FA is on.
	if _, err := q.ConfirmTOTP(ctx, user); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAlreadyEnabled
	} else if err != nil {
		return nil, fmt.Errorf("twofactor: confirm: %w", err)
	}
	if _, err := q.DeleteBackupCodesForUser(ctx, user); err != nil {
		return nil, fmt.Errorf("twofactor: delete backup codes: %w", err)
	}
	if _, err := q.CreateBackupCodes(ctx, db.CreateBackupCodesParams{Ids: ids, UserID: user, CodeHashes: hashes}); err != nil {
		return nil, fmt.Errorf("twofactor: store backup codes: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.TOTPEnabled,
		Meta:  map[string]any{"backup_codes": len(codes)},
	}); err != nil {
		return nil, err
	}
	ip := ""
	if req := audit.RequestFrom(ctx); req.IP.IsValid() {
		ip = req.IP.String()
	}
	if _, err := s.jobs.InsertTx(ctx, tx, email.SendArgs{
		To:       u.Email,
		Template: email.TemplateSecurityChange,
		Data: map[string]any{
			"change": email.SecurityChangeTOTPEnabled,
			"device": device,
			"ip":     ip,
			"time":   now.UTC().Format(time.RFC3339),
		},
	}, nil); err != nil {
		return nil, fmt.Errorf("twofactor: enqueue email: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("twofactor: commit: %w", err)
	}
	return codes, nil
}

// secretAD binds a sealed secret to its user.
func secretAD(user uuid.UUID) []byte { return []byte("user_totp:" + user.String()) }

// SealSecret encrypts user's base32 TOTP secret for user_totp.secret_enc.
func (s *Service) SealSecret(user uuid.UUID, secret string) ([]byte, error) {
	b, err := s.sealer.Seal([]byte(secret), secretAD(user))
	if err != nil {
		return nil, fmt.Errorf("twofactor: seal secret: %w", err)
	}
	return b, nil
}

// OpenSecret decrypts user's stored TOTP secret. It fails with
// keys.ErrDecrypt for a wrong key or a ciphertext of another user.
func (s *Service) OpenSecret(user uuid.UUID, sealed []byte) (string, error) {
	b, err := s.sealer.Open(sealed, secretAD(user))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// NewBackupCodes returns BackupCodeCount distinct random codes formatted
// xxxx-xxxx.
func NewBackupCodes() ([]string, error) {
	codes := make([]string, 0, BackupCodeCount)
	seen := make(map[string]bool, BackupCodeCount)
	buf := make([]byte, 2*backupCodeHalf)
	for len(codes) < BackupCodeCount {
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("twofactor: backup code: %w", err)
		}
		var b strings.Builder
		for i, v := range buf {
			if i == backupCodeHalf {
				b.WriteByte('-')
			}
			// 256 is a multiple of 32, so the low five bits are uniform.
			b.WriteByte(backupCodeAlphabet[v&31])
		}
		if c := b.String(); !seen[c] {
			seen[c] = true
			codes = append(codes, c)
		}
	}
	return codes, nil
}

// NormalizeBackupCode lower-cases code and drops dashes and whitespace, so
// "ABCD-EFGH", "abcd efgh" and "abcdefgh" are the same code.
func NormalizeBackupCode(code string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '-' || r == ' ' || r == '\t' || r == '\n' || r == '\r':
			return -1
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		}
		return r
	}, code)
}

// HashBackupCode is the stored form of a backup code: hex SHA-256 of the
// user id and the normalized code. Salting with the user id means a stolen
// table gives no shared lookup table.
func HashBackupCode(user uuid.UUID, code string) string {
	sum := sha256.Sum256([]byte("backup_code:" + user.String() + ":" + NormalizeBackupCode(code)))
	return hex.EncodeToString(sum[:])
}
