// Package emailauth issues and verifies the one-time secrets of a sign-in
// email: a magic link and a 6-digit code, sent together and stored in one
// auth_email_tokens row.
//
//   - The link token is 32 random bytes, base64url without padding (256 bits),
//     so it is unguessable and may be looked up directly by its hash.
//   - The code is 6 decimal digits drawn uniformly from crypto/rand (leading
//     zeros included). It is low entropy, so it is only checked against the
//     latest email of the address it was sent to, with a constant-time compare
//     and at most MaxAttempts wrong guesses.
//
// Only SHA-256 hashes of the two secrets are stored. The code hash is salted
// with the row id so a stolen table gives no shared lookup table.
//
// Both secrets live TTL (15 minutes) and are single use: using either one
// consumes the row, so the other stops working too. Issuing a new email
// invalidates every older unconsumed row of the address, so only the newest
// link and code work.
//
// The errors map onto identity's error catalogue: ErrInvalidCode and
// ErrInvalidLink → invalid_code / invalid_token, ErrCodeExpired and
// ErrLinkExpired → code_expired, ErrTooManyAttempts → too_many_attempts.
package emailauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/netip"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// TTL is how long a link and code stay usable after they are issued.
const TTL = 15 * time.Minute

// MaxAttempts is the number of wrong code guesses a row tolerates. The guess
// that reaches it answers ErrTooManyAttempts, and so does every later one,
// right or wrong, until a new code is issued.
const MaxAttempts = 5

// CodeLength is the number of digits in a code.
const CodeLength = 6

// linkTokenBytes is the entropy of a link token (256 bits).
const linkTokenBytes = 32

// codeSpace is the number of distinct codes (10^CodeLength).
var codeSpace = big.NewInt(1_000_000)

// Intent is why the email was sent; it matches the auth_email_tokens check.
type Intent string

// Email intents.
const (
	IntentSignIn      Intent = "signin"
	IntentSignUp      Intent = "signup"
	IntentVerifyEmail Intent = "verify_email"
	IntentChangeEmail Intent = "change_email"
)

// Valid reports whether i is a known intent.
func (i Intent) Valid() bool {
	switch i {
	case IntentSignIn, IntentSignUp, IntentVerifyEmail, IntentChangeEmail:
		return true
	}
	return false
}

var (
	// ErrInvalidCode means the code is malformed or wrong, or the address has
	// no outstanding email. The cases are indistinguishable on purpose.
	ErrInvalidCode = errors.New("emailauth: invalid_code")
	// ErrCodeExpired means the code matched the address's latest email, but
	// that email has expired.
	ErrCodeExpired = errors.New("emailauth: code_expired")
	// ErrTooManyAttempts means the latest email of the address took
	// MaxAttempts wrong guesses; a new code must be requested.
	ErrTooManyAttempts = errors.New("emailauth: too_many_attempts")
	// ErrInvalidLink means the link token is malformed, unknown, already used
	// or superseded by a newer email.
	ErrInvalidLink = errors.New("emailauth: invalid_link")
	// ErrLinkExpired means the link token is genuine but has expired.
	ErrLinkExpired = errors.New("emailauth: link_expired")
	// ErrInvalidRequest means Issue was called with an empty email or an
	// unknown intent.
	ErrInvalidRequest = errors.New("emailauth: invalid request")
)

// Queries is the subset of the identity queries emailauth uses;
// *db.Queries satisfies it.
type Queries interface {
	CreateEmailToken(ctx context.Context, arg db.CreateEmailTokenParams) (db.AuthEmailToken, error)
	GetEmailTokenByLinkHash(ctx context.Context, linkTokenHash string) (db.AuthEmailToken, error)
	GetLatestUnconsumedEmailTokenForEmail(ctx context.Context, email string) (db.AuthEmailToken, error)
	IncrementEmailTokenAttempts(ctx context.Context, id uuid.UUID) (int32, error)
	ConsumeEmailToken(ctx context.Context, id uuid.UUID) (db.AuthEmailToken, error)
	InvalidateEmailTokensForEmail(ctx context.Context, email string) (int64, error)
}

// Store is Queries plus transactions.
type Store interface {
	Queries
	// InTx runs fn with queries bound to one transaction, committed when fn
	// returns nil and rolled back otherwise.
	InTx(ctx context.Context, fn func(Queries) error) error
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// pgStore is the Postgres Store.
type pgStore struct {
	*db.Queries
	pool TxBeginner
}

// NewStore returns the Postgres Store over pool.
func NewStore(pool TxBeginner) Store {
	return &pgStore{Queries: db.New(pool), pool: pool}
}

func (s *pgStore) InTx(ctx context.Context, fn func(Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(s.WithTx(tx)) })
}

// Service issues and verifies sign-in email secrets.
type Service struct {
	store Store
	now   func() time.Time
	rand  func() (link, code string, err error)
}

// Options configures a Service. The zero value is the production setting.
type Options struct {
	// Now is the clock used for expiry. Nil means time.Now.
	Now func() time.Time
}

// New returns a Service over store.
func New(store Store, opts Options) *Service {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Service{store: store, now: now, rand: newSecrets}
}

// IssueOptions are the optional facts stored with an email.
type IssueOptions struct {
	// UserID is the account the email belongs to, if it has one.
	UserID *uuid.UUID
	// NextPath is the relative path to land on after signing in. The table
	// rejects anything but a relative path of at most 512 characters.
	NextPath *string
	// IP and UserAgent describe the requester, for the audit trail.
	IP        *netip.Addr
	UserAgent string
}

// Issued is a freshly issued email: the two secrets to send, and the row.
// LinkToken and Code exist only here; the row holds their hashes.
type Issued struct {
	LinkToken string
	Code      string
	Row       db.AuthEmailToken
}

// Issue creates the link token and code for one email to address email and
// stores their hashes. It invalidates the address's older unconsumed emails
// in the same transaction, so only the newest link and code work.
func (s *Service) Issue(ctx context.Context, email string, intent Intent, opts IssueOptions) (Issued, error) {
	email = strings.TrimSpace(email)
	if email == "" || !intent.Valid() {
		return Issued{}, ErrInvalidRequest
	}
	link, code, err := s.rand()
	if err != nil {
		return Issued{}, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Issued{}, fmt.Errorf("emailauth: id: %w", err)
	}
	params := db.CreateEmailTokenParams{
		ID:            id,
		Email:         email,
		Intent:        string(intent),
		UserID:        opts.UserID,
		LinkTokenHash: hashLink(link),
		CodeHash:      hashCode(id, code),
		NextPath:      opts.NextPath,
		Ip:            opts.IP,
		UserAgent:     opts.UserAgent,
		ExpiresAt:     s.now().Add(TTL),
	}
	var row db.AuthEmailToken
	err = s.store.InTx(ctx, func(q Queries) error {
		if _, err := q.InvalidateEmailTokensForEmail(ctx, email); err != nil {
			return fmt.Errorf("emailauth: invalidate: %w", err)
		}
		var err error
		if row, err = q.CreateEmailToken(ctx, params); err != nil {
			return fmt.Errorf("emailauth: create: %w", err)
		}
		return nil
	})
	if err != nil {
		return Issued{}, err
	}
	return Issued{LinkToken: link, Code: code, Row: row}, nil
}

// Latest returns the latest unconsumed email of address email (expired or
// not), and false when there is none. Issuing a new email invalidates older
// ones, so this is the newest email the address was sent; the email-start
// endpoint uses its CreatedAt for the resend cooldown.
func (s *Service) Latest(ctx context.Context, email string) (db.AuthEmailToken, bool, error) {
	row, err := s.store.GetLatestUnconsumedEmailTokenForEmail(ctx, strings.TrimSpace(email))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return db.AuthEmailToken{}, false, nil
	case err != nil:
		return db.AuthEmailToken{}, false, fmt.Errorf("emailauth: latest: %w", err)
	}
	return row, true, nil
}

// VerifyCode checks a typed code against the latest email sent to email and,
// when it matches, consumes the row and returns it.
//
// It returns ErrInvalidCode for a malformed or wrong code and for an address
// with no outstanding email, ErrCodeExpired when the code matches an expired
// email, and ErrTooManyAttempts once MaxAttempts wrong guesses were made. A
// wrong guess on a live email counts one attempt.
//
// The hash compare runs whether or not a row exists, so response time does
// not reveal which addresses have an outstanding email.
func (s *Service) VerifyCode(ctx context.Context, email, code string) (db.AuthEmailToken, error) {
	email = strings.TrimSpace(email)
	parsed, parseErr := ParseCode(code)

	row, err := s.store.GetLatestUnconsumedEmailTokenForEmail(ctx, email)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.AuthEmailToken{}, fmt.Errorf("emailauth: lookup: %w", err)
	}
	// Always hash and compare, against a dummy row when there is none.
	id, want := dummyID, dummyCodeHash
	if found {
		id, want = row.ID, row.CodeHash
	}
	match := subtle.ConstantTimeCompare([]byte(hashCode(id, parsed)), []byte(want)) == 1
	match = match && parseErr == nil && found

	switch {
	case !found:
		return db.AuthEmailToken{}, ErrInvalidCode
	case row.Attempts >= MaxAttempts:
		return db.AuthEmailToken{}, ErrTooManyAttempts
	case !s.now().Before(row.ExpiresAt):
		if match {
			return db.AuthEmailToken{}, ErrCodeExpired
		}
		return db.AuthEmailToken{}, ErrInvalidCode
	case !match:
		n, err := s.store.IncrementEmailTokenAttempts(ctx, row.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Consumed or expired since the lookup.
			return db.AuthEmailToken{}, ErrInvalidCode
		case err != nil:
			return db.AuthEmailToken{}, fmt.Errorf("emailauth: count attempt: %w", err)
		case n >= MaxAttempts:
			return db.AuthEmailToken{}, ErrTooManyAttempts
		}
		return db.AuthEmailToken{}, ErrInvalidCode
	}
	return s.consume(ctx, row.ID, ErrInvalidCode)
}

// VerifyLink checks a magic-link token and, when it is live, consumes its row
// and returns it. It returns ErrInvalidLink for a malformed, unknown, used or
// superseded token and ErrLinkExpired for an expired one. Wrong code guesses
// do not lock the link out: it carries 256 bits and cannot be guessed.
func (s *Service) VerifyLink(ctx context.Context, raw string) (db.AuthEmailToken, error) {
	if !validLinkToken(raw) {
		return db.AuthEmailToken{}, ErrInvalidLink
	}
	row, err := s.store.GetEmailTokenByLinkHash(ctx, hashLink(raw))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return db.AuthEmailToken{}, ErrInvalidLink
	case err != nil:
		return db.AuthEmailToken{}, fmt.Errorf("emailauth: lookup: %w", err)
	case row.ConsumedAt != nil:
		return db.AuthEmailToken{}, ErrInvalidLink
	case !s.now().Before(row.ExpiresAt):
		return db.AuthEmailToken{}, ErrLinkExpired
	}
	return s.consume(ctx, row.ID, ErrInvalidLink)
}

// consume marks the row used. Losing a race to another consume (or to expiry
// or invalidation) answers lost.
func (s *Service) consume(ctx context.Context, id uuid.UUID, lost error) (db.AuthEmailToken, error) {
	row, err := s.store.ConsumeEmailToken(ctx, id)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return db.AuthEmailToken{}, lost
	case err != nil:
		return db.AuthEmailToken{}, fmt.Errorf("emailauth: consume: %w", err)
	}
	return row, nil
}

// ParseCode normalises a typed code: it drops spaces, tabs and hyphens (as in
// "123 456" or "123-456") and requires exactly CodeLength ASCII digits.
func ParseCode(s string) (string, error) {
	if len(s) > 64 {
		return "", ErrInvalidCode
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == ' ' || c == '\t' || c == '-':
		case c >= '0' && c <= '9':
			if b.Len() == CodeLength {
				return "", ErrInvalidCode
			}
			b.WriteByte(c)
		default:
			return "", ErrInvalidCode
		}
	}
	if b.Len() != CodeLength {
		return "", ErrInvalidCode
	}
	return b.String(), nil
}

// newSecrets draws a link token and a code from crypto/rand.
func newSecrets() (link, code string, err error) {
	buf := make([]byte, linkTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("emailauth: link token: %w", err)
	}
	// rand.Int is uniform over [0, 10^6): no modulo bias, leading zeros kept.
	n, err := rand.Int(rand.Reader, codeSpace)
	if err != nil {
		return "", "", fmt.Errorf("emailauth: code: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), fmt.Sprintf("%0*d", CodeLength, n.Int64()), nil
}

// validLinkToken reports whether raw is shaped like a link token.
func validLinkToken(raw string) bool {
	if len(raw) != base64.RawURLEncoding.EncodedLen(linkTokenBytes) {
		return false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	return err == nil && len(b) == linkTokenBytes
}

// hashLink is the stored hash of a link token: hex SHA-256.
func hashLink(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// hashCode is the stored hash of a code: hex SHA-256 over a domain label, the
// row id (a per-row salt) and the code.
func hashCode(id uuid.UUID, code string) string {
	h := sha256.New()
	h.Write([]byte("apilens/email-code\x00"))
	h.Write(id[:])
	h.Write([]byte(code))
	return hex.EncodeToString(h.Sum(nil))
}

// dummyID and dummyCodeHash stand in for a row when an address has none, so
// VerifyCode does the same hashing and compare either way.
var (
	dummyID       = uuid.MustParse("00000000-0000-7000-8000-000000000000")
	dummyCodeHash = hashCode(dummyID, "\x00")
)
