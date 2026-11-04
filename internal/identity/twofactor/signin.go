package twofactor

// The second step of a sign-in: a user whose first factor (email, social,
// SSO) succeeded with TOTP confirmed proves the second factor. It backs
// POST /api/v1/auth/2fa/exchange.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// SignIn checks the second factor of user's sign-in: exactly one of a code
// from the authenticator app and an unused backup code, which it marks used.
// It returns the user and the factor's `amr` value ("totp" or
// "backup_code"). It answers ErrProofRequired when p carries neither or
// both, ErrUserNotFound for a deleted user, ErrNotEnabled when 2FA was
// turned off meanwhile and ErrInvalidCode for a wrong code or a wrong or
// spent backup code.
func (s *Service) SignIn(ctx context.Context, user uuid.UUID, p Proof) (db.User, string, error) {
	if (p.Code == "") == (p.BackupCode == "") {
		return db.User{}, "", ErrProofRequired
	}
	u, err := s.user(ctx, user)
	if err != nil {
		return db.User{}, "", err
	}
	row, err := s.q.GetTOTPForUser(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && row.ConfirmedAt == nil {
		return db.User{}, "", ErrNotEnabled
	}
	if err != nil {
		return db.User{}, "", fmt.Errorf("twofactor: get secret: %w", err)
	}
	if p.Code != "" {
		if err := s.checkCode(user, row, p.Code, s.now()); err != nil {
			return db.User{}, "", err
		}
		return u, p.method(), nil
	}
	// Of two concurrent uses of one backup code only one succeeds.
	_, err = s.q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: user, CodeHash: HashBackupCode(user, p.BackupCode)})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, "", ErrInvalidCode
	}
	if err != nil {
		return db.User{}, "", fmt.Errorf("twofactor: use backup code: %w", err)
	}
	return u, p.method(), nil
}
