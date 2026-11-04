package orgs

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// JoinViaSSO makes user a member of the organization org with role, the
// default role of the organization's SSO connection, unless they already
// are one (their role is then left alone). It is the just-in-time membership
// of an SSO sign-in: the new membership and its membership.upserted outbox
// row commit together. joined reports whether a membership was created.
// role must be admin, member or viewer; SSO never grants owner.
func (s *Service) JoinViaSSO(ctx context.Context, org, user uuid.UUID, role string) (joined bool, err error) {
	if !ValidRole(role) || role == RoleOwner {
		return false, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	_, err = q.GetMembership(ctx, db.GetMembershipParams{OrgID: org, UserID: user})
	switch {
	case err == nil:
		return false, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return false, fmt.Errorf("orgs: get membership: %w", err)
	}
	_, err = q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: org, UserID: user, Role: role})
	if isViolation(err, "23505", "") {
		// A concurrent sign-in of the same user created it first.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("orgs: create membership: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: role}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("orgs: commit: %w", err)
	}
	return true, nil
}
