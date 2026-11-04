package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
)

// TwoFactorRequiredStatus is the `status` of a sign-in answer that needs a
// second factor before a session is issued.
const TwoFactorRequiredStatus = "2fa_required"

// SignInResponse is the body of a successful first-factor sign-in: either
// the session bundle (access_token, refresh_token, expires_in, user) or,
// when the user has TOTP confirmed, {status: "2fa_required", pre_auth_token}.
// Both carry `next` when the sign-in was started with one.
type SignInResponse struct {
	Status       string    `json:"status,omitempty" enum:"2fa_required" doc:"Present only as \"2fa_required\": exchange pre_auth_token with a TOTP or backup code at POST /api/v1/auth/2fa/exchange."`
	PreAuthToken string    `json:"pre_auth_token,omitempty" doc:"Opaque, short-lived token for the second-factor step; only with status 2fa_required."`
	AccessToken  string    `json:"access_token,omitempty" doc:"RS256 access token (JWT); send it as a bearer token."`
	RefreshToken string    `json:"refresh_token,omitempty" doc:"Opaque refresh token. It is single-use: every refresh returns a new one, and presenting a used one again revokes the session."`
	ExpiresIn    int       `json:"expires_in,omitempty" minimum:"1" doc:"Seconds until the access token expires."`
	User         *AuthUser `json:"user,omitempty"`
	Next         string    `json:"next,omitempty" doc:"Relative path to open after sign-in: as requested when the sign-in started, or /onboarding/about for a new user who requested none."`
}

// NewSignInSession renders a session bundle, with expires_in counted from
// now.
func NewSignInSession(t session.Tokens, next string, now time.Time) SignInResponse {
	tr := NewTokenResponse(t, now)
	return SignInResponse{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		ExpiresIn:    tr.ExpiresIn,
		User:         &tr.User,
		Next:         next,
	}
}

// NewSignInTwoFactor renders the 2fa_required answer.
func NewSignInTwoFactor(preAuthToken, next string) SignInResponse {
	return SignInResponse{Status: TwoFactorRequiredStatus, PreAuthToken: preAuthToken, Next: next}
}

// SignInUsers finds or creates the user of a first-factor sign-in and reads
// what the sign-in needs about them; *PGSignInUsers satisfies it.
type SignInUsers interface {
	// FindOrCreateVerified returns the active user with address email,
	// marking the address verified, or creates and bootstraps one
	// (users.FindOrCreateByVerifiedEmail with source email). created reports
	// which; a new user's sign-in continues at users.OnboardingPath.
	FindOrCreateVerified(ctx context.Context, email string) (user db.User, created bool, err error)
	// TOTPConfirmed reports whether the user has two-factor (TOTP) enabled.
	TOTPConfirmed(ctx context.Context, user uuid.UUID) (bool, error)
	// TouchLastLogin records a completed sign-in.
	TouchLastLogin(ctx context.Context, user uuid.UUID) error
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// PGSignInUsers is the Postgres SignInUsers.
type PGSignInUsers struct {
	users *users.Service
	q     *db.Queries
}

// NewPGSignInUsers returns the Postgres SignInUsers over pool.
func NewPGSignInUsers(pool TxBeginner) *PGSignInUsers {
	return &PGSignInUsers{users: users.New(pool), q: db.New(pool)}
}

// FindOrCreateVerified implements SignInUsers for the email sign-in paths:
// it is users.FindOrCreateByVerifiedEmail with source email.
func (s *PGSignInUsers) FindOrCreateVerified(ctx context.Context, email string) (db.User, bool, error) {
	return s.users.FindOrCreateByVerifiedEmail(ctx, email, users.SourceEmail)
}

// TOTPConfirmed implements SignInUsers. A pending (unconfirmed) secret does
// not count.
func (s *PGSignInUsers) TOTPConfirmed(ctx context.Context, user uuid.UUID) (bool, error) {
	row, err := s.q.GetTOTPForUser(ctx, user)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, fmt.Errorf("identity: load totp: %w", err)
	}
	return row.ConfirmedAt != nil, nil
}

// TouchLastLogin implements SignInUsers.
func (s *PGSignInUsers) TouchLastLogin(ctx context.Context, user uuid.UUID) error {
	if err := s.q.TouchLastLogin(ctx, user); err != nil {
		return fmt.Errorf("identity: touch last login: %w", err)
	}
	return nil
}
