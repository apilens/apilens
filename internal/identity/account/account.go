// Package account manages the signed-in user's own account: reading the
// profile, updating profile and preferences, and deleting the account with a
// grace period. It backs GET/PATCH/DELETE /api/v1/users/me.
//
// Deleting is a soft delete: the user row is hidden at once (its email is
// free to sign up again), every session is revoked, and delete_after is set
// to now + Grace. A purge job hard-deletes the row once delete_after has
// passed; until then the account can be restored.
package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// Grace is how long a deleted account is kept before the purge job removes
// it for good.
const Grace = 30 * 24 * time.Hour

// Home screens a user can choose as the `home` preference.
const (
	HomeEndpoints  = "endpoints"
	HomeRequests   = "requests"
	HomeExceptions = "exceptions"
)

// Homes lists the valid `home` preference values.
var Homes = []string{HomeEndpoints, HomeRequests, HomeExceptions}

var (
	// ErrNotFound means the user does not exist or is already deleted.
	ErrNotFound = errors.New("account: user not found")
	// ErrOwnerTransferRequired means the user is the only owner of at least
	// one organization and must transfer ownership (or delete the
	// organization) before deleting the account.
	ErrOwnerTransferRequired = errors.New("account: sole owner of an organization")
	// ErrInvalidPreference means a preference value is not allowed.
	ErrInvalidPreference = errors.New("account: invalid preference")
)

// OwnershipChecker reports the organizations a user is the only owner of.
// Memberships live in the control plane; the implementation backed by the
// memberships table arrives with it (#276).
type OwnershipChecker interface {
	SoleOwnedOrgs(ctx context.Context, user uuid.UUID) ([]uuid.UUID, error)
}

// NoMemberships is the OwnershipChecker used until memberships exist: no
// user owns an organization, so nothing blocks a deletion.
type NoMemberships struct{}

// SoleOwnedOrgs returns no organizations.
func (NoMemberships) SoleOwnedOrgs(context.Context, uuid.UUID) ([]uuid.UUID, error) {
	return nil, nil
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service reads and changes the signed-in user's account.
type Service struct {
	pool   TxBeginner
	q      *db.Queries
	audit  *audit.Recorder
	owners OwnershipChecker
	now    func() time.Time
}

// New returns a Service over pool. owners decides whether a deletion must
// wait for an ownership transfer; nil means NoMemberships.
func New(pool TxBeginner, owners OwnershipChecker) *Service {
	if owners == nil {
		owners = NoMemberships{}
	}
	return &Service{pool: pool, q: db.New(pool), audit: audit.New(pool), owners: owners, now: time.Now}
}

// Patch is a partial update of the account. Nil fields stay unchanged.
type Patch struct {
	Name      *string
	AvatarURL *string
	// Preferences is shallow-merged into the stored preferences.
	Preferences map[string]any
}

// Get returns the active user id.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (db.User, error) {
	u, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrNotFound
	}
	if err != nil {
		return db.User{}, fmt.Errorf("account: get user: %w", err)
	}
	return u, nil
}

// Update applies p to user id and audits user.updated with the names (never
// the values) of the changed fields. An empty patch returns the user as is.
func (s *Service) Update(ctx context.Context, id uuid.UUID, p Patch) (db.User, error) {
	if err := ValidatePreferences(p.Preferences); err != nil {
		return db.User{}, err
	}
	var fields []string
	if p.Name != nil {
		fields = append(fields, "name")
	}
	if p.AvatarURL != nil {
		fields = append(fields, "avatar_url")
	}
	for k := range p.Preferences {
		fields = append(fields, "preferences."+k)
	}
	if len(fields) == 0 {
		return s.Get(ctx, id)
	}
	slices.Sort(fields)

	var user db.User
	err := s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		if p.Name != nil || p.AvatarURL != nil {
			user, err = q.UpdateUserProfile(ctx, db.UpdateUserProfileParams{ID: id, Name: p.Name, AvatarUrl: p.AvatarURL})
			if err != nil {
				return notFound(err, "update profile")
			}
		}
		if len(p.Preferences) > 0 {
			patch, err := json.Marshal(p.Preferences)
			if err != nil {
				return fmt.Errorf("account: encode preferences: %w", err)
			}
			user, err = q.UpdateUserPreferences(ctx, db.UpdateUserPreferencesParams{ID: id, Patch: patch})
			if err != nil {
				return notFound(err, "update preferences")
			}
		}
		return s.audit.Record(ctx, audit.Event{
			User:  &id,
			Actor: &id,
			Kind:  audit.UserUpdated,
			Meta:  map[string]any{"fields": fields},
		})
	})
	if err != nil {
		return db.User{}, err
	}
	return user, nil
}

// Deletion is the outcome of Delete.
type Deletion struct {
	// DeleteAfter is when the purge job removes the account for good.
	DeleteAfter time.Time
	// SessionsRevoked counts the sessions ended by the deletion.
	SessionsRevoked int64
}

// Delete soft-deletes user id with a Grace period, revokes all of its
// sessions and audits user.deleted, in one transaction. It refuses with
// ErrOwnerTransferRequired while the user is the only owner of an
// organization.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) (Deletion, error) {
	orgs, err := s.owners.SoleOwnedOrgs(ctx, id)
	if err != nil {
		return Deletion{}, fmt.Errorf("account: check ownership: %w", err)
	}
	if len(orgs) > 0 {
		return Deletion{}, ErrOwnerTransferRequired
	}
	var out Deletion
	err = s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		u, err := q.SoftDeleteUser(ctx, db.SoftDeleteUserParams{ID: id, DeleteAfter: s.now().Add(Grace)})
		if err != nil {
			return notFound(err, "soft delete")
		}
		n, err := q.RevokeAllForUser(ctx, db.RevokeAllForUserParams{UserID: id, Reason: session.ReasonUserDeleted})
		if err != nil {
			return fmt.Errorf("account: revoke sessions: %w", err)
		}
		out = Deletion{DeleteAfter: *u.DeleteAfter, SessionsRevoked: n}
		return s.audit.Record(ctx, audit.Event{
			User:  &id,
			Actor: &id,
			Kind:  audit.UserDeleted,
			Meta:  map[string]any{"delete_after": out.DeleteAfter.UTC().Format(time.RFC3339), "sessions_revoked": n},
		})
	})
	if err != nil {
		return Deletion{}, err
	}
	return out, nil
}

// ValidatePreferences checks the known preference keys of a patch: `home`
// must be one of Homes. Unknown keys are the caller's schema's concern.
func ValidatePreferences(p map[string]any) error {
	if v, ok := p["home"]; ok {
		h, isString := v.(string)
		if !isString || !slices.Contains(Homes, h) {
			return fmt.Errorf("%w: home must be one of %v", ErrInvalidPreference, Homes)
		}
	}
	return nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (s *Service) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("account: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("account: commit: %w", err)
	}
	return nil
}

func notFound(err error, op string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return fmt.Errorf("account: %s: %w", op, err)
}
