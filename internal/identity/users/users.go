// Package users holds the one "find or create user" step every sign-in
// method ends in. Email codes and links, Google, GitHub and SSO callbacks all
// prove control of an email address and then call
// Service.FindOrCreateByVerifiedEmail; nothing else creates users (a test
// checks), so every new account starts with the same defaults and audit
// trail.
//
// A first login bootstraps the user: the address is verified, last_login_at
// is set, preferences start as {home: "endpoints"} and onboarding as
// {step: "about"}, and user.created is audited with the sign-in source. The
// caller learns the user is new (created) and sends them to OnboardingPath.
package users

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// Source is the sign-in method that verified the address. It is recorded as
// the `method` of the user.created audit event.
type Source string

// The sign-in sources.
const (
	SourceEmail  Source = "email"
	SourceGoogle Source = "google"
	SourceGitHub Source = "github"
	SourceSSO    Source = "sso"
)

// Valid reports whether s is a known source.
func (s Source) Valid() bool {
	switch s {
	case SourceEmail, SourceGoogle, SourceGitHub, SourceSSO:
		return true
	}
	return false
}

// OnboardingPath is where a newly created user goes after signing in.
const OnboardingPath = "/onboarding/about"

// OnboardingStepAbout is the first onboarding step, stored as
// onboarding.step for a new user.
const OnboardingStepAbout = "about"

// ErrInvalidSource means FindOrCreateByVerifiedEmail was called with an
// unknown Source.
var ErrInvalidSource = errors.New("users: invalid sign-in source")

// DefaultPreferences returns the preferences a new user starts with.
func DefaultPreferences() map[string]any {
	return map[string]any{"home": account.HomeEndpoints}
}

// DefaultOnboarding returns the onboarding state a new user starts with.
func DefaultOnboarding() map[string]any {
	return map[string]any{"step": OnboardingStepAbout}
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service finds or creates users by verified email.
type Service struct {
	pool  TxBeginner
	q     *db.Queries
	audit *audit.Recorder
	now   func() time.Time
}

// New returns a Service over pool.
func New(pool TxBeginner) *Service {
	return &Service{pool: pool, q: db.New(pool), audit: audit.New(pool), now: time.Now}
}

// FindOrCreateByVerifiedEmail returns the active user with address email,
// marking the address verified if it was not, or creates and bootstraps one
// (see the package doc). created reports which. The lookup ignores case.
//
// Of two concurrent first logins for one address one creates the user and
// the other, losing on the unique users_email_active index, retries once and
// finds it.
func (s *Service) FindOrCreateByVerifiedEmail(ctx context.Context, email string, source Source) (user db.User, created bool, err error) {
	if !source.Valid() {
		return db.User{}, false, fmt.Errorf("%w: %q", ErrInvalidSource, source)
	}
	for attempt := 0; ; attempt++ {
		user, created, err := s.findOrCreate(ctx, email, source)
		var pgErr *pgconn.PgError
		if err != nil && attempt == 0 && errors.As(err, &pgErr) && pgErr.Code == "23505" {
			continue
		}
		return user, created, err
	}
}

func (s *Service) findOrCreate(ctx context.Context, email string, source Source) (db.User, bool, error) {
	var (
		user    db.User
		created bool
	)
	err := s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		user, err = q.GetUserByEmail(ctx, email)
		switch {
		case err == nil:
			if user.EmailVerifiedAt == nil {
				if user, err = q.MarkUserEmailVerified(ctx, user.ID); err != nil {
					return fmt.Errorf("users: mark email verified: %w", err)
				}
			}
			return nil
		case !errors.Is(err, pgx.ErrNoRows):
			return fmt.Errorf("users: look up user: %w", err)
		}
		prefs, err := json.Marshal(DefaultPreferences())
		if err != nil {
			return fmt.Errorf("users: encode preferences: %w", err)
		}
		onboarding, err := json.Marshal(DefaultOnboarding())
		if err != nil {
			return fmt.Errorf("users: encode onboarding: %w", err)
		}
		now := s.now()
		user, err = q.CreateFirstLoginUser(ctx, db.CreateFirstLoginUserParams{
			ID:              uuid.New(),
			Email:           email,
			EmailVerifiedAt: &now,
			Preferences:     prefs,
			Onboarding:      onboarding,
			LastLoginAt:     &now,
		})
		if err != nil {
			return fmt.Errorf("users: create user: %w", err)
		}
		created = true
		return s.audit.Record(ctx, audit.Event{
			User:  &user.ID,
			Actor: &user.ID,
			Kind:  audit.UserCreated,
			Meta:  map[string]any{"method": string(source)},
		})
	})
	if err != nil {
		return db.User{}, false, err
	}
	return user, created, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (s *Service) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("users: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("users: commit: %w", err)
	}
	return nil
}
