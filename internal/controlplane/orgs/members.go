package orgs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// The membership roles below owner and admin.
const (
	RoleMember = "member"
	RoleViewer = "viewer"
)

// Roles lists the membership roles, most to least privileged.
var Roles = []string{RoleOwner, RoleAdmin, RoleMember, RoleViewer}

// ValidRole reports whether role is a membership role.
func ValidRole(role string) bool { return slices.Contains(Roles, role) }

// Errors returned by the member operations of Service, besides ErrNotFound
// (no such organization, or the caller is not a member) and ErrForbidden.
var (
	// ErrMemberNotFound: the target user is not a member of the organization
	// (or their account is deleted).
	ErrMemberNotFound = errors.New("orgs: member not found")
	// ErrLastOwner: the change would leave the organization without an
	// owner.
	ErrLastOwner = errors.New("orgs: last owner")
)

// Member is a member of an organization with their user.
type Member struct {
	UserID      uuid.UUID
	Email       string
	Name        string
	AvatarURL   string
	Role        string
	JoinedAt    time.Time
	LastLoginAt *time.Time
}

// Members lists the members of the organization slug, oldest first. Any
// member may list them.
func (s *Service) Members(ctx context.Context, user uuid.UUID, slug string) ([]Member, error) {
	q := db.New(s.pool)
	org, err := q.GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("orgs: get: %w", err)
	}
	rows, err := q.ListOrgMembers(ctx, org.ID)
	if err != nil {
		return nil, fmt.Errorf("orgs: list members: %w", err)
	}
	out := make([]Member, 0, len(rows))
	for _, r := range rows {
		out = append(out, member(db.GetOrgMemberRow(r)))
	}
	return out, nil
}

// ChangeRole sets target's role in the organization slug on behalf of user,
// who must be an owner or admin. Only owners may make someone an owner or
// change an owner's role, and the last owner cannot be demoted
// (ErrLastOwner). A change emits membership.upserted and audits
// member.role_changed; setting the current role changes nothing.
func (s *Service) ChangeRole(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID, role string) (Member, error) {
	if !ValidRole(role) {
		return Member{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Member{}, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return Member{}, err
	}
	if !CanManage(org.Role) {
		return Member{}, ErrForbidden
	}
	m, err := getMember(ctx, q, org.ID, target)
	if err != nil {
		return Member{}, err
	}
	if (role == RoleOwner || m.Role == RoleOwner) && org.Role != RoleOwner {
		return Member{}, ErrForbidden
	}
	if m.Role == role {
		return member(m), nil
	}
	if m.Role == RoleOwner {
		if err := ensureAnotherOwner(ctx, q, org.ID); err != nil {
			return Member{}, err
		}
	}
	if err := s.setRole(ctx, tx, user, org, target, m.Role, role); err != nil {
		return Member{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Member{}, fmt.Errorf("orgs: commit: %w", err)
	}
	m.Role = role
	return member(m), nil
}

// RemoveMember removes target from the organization slug on behalf of user,
// who must be an owner or admin; only owners may remove an owner, and the
// last owner cannot be removed (ErrLastOwner). It emits membership.deleted
// and audits member.removed.
func (s *Service) RemoveMember(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID) error {
	return s.remove(ctx, user, slug, target)
}

// Leave removes user from the organization slug. The last owner cannot leave
// (ErrLastOwner): they transfer ownership or delete the organization first.
// It emits membership.deleted and audits member.removed.
func (s *Service) Leave(ctx context.Context, user uuid.UUID, slug string) error {
	return s.remove(ctx, user, slug, user)
}

func (s *Service) remove(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return err
	}
	self := target == user
	if !self && !CanManage(org.Role) {
		return ErrForbidden
	}
	m, err := getMember(ctx, q, org.ID, target)
	if err != nil {
		return err
	}
	if m.Role == RoleOwner {
		if !self && org.Role != RoleOwner {
			return ErrForbidden
		}
		if err := ensureAnotherOwner(ctx, q, org.ID); err != nil {
			return err
		}
	}
	if _, err := q.DeleteMembership(ctx, db.DeleteMembershipParams{OrgID: org.ID, UserID: target}); err != nil {
		return fmt.Errorf("orgs: delete membership: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.MembershipDeleted, org.ID, outbox.MembershipDeletedPayload{OrgID: org.ID, UserID: target}); err != nil {
		return err
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &target,
		Actor: &user,
		Kind:  audit.MemberRemoved,
		Meta:  map[string]any{"org_id": org.ID.String(), "slug": org.Slug, "role": m.Role, "left": self},
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("orgs: commit: %w", err)
	}
	return nil
}

// TransferOwnership makes target an owner of the organization slug and
// demotes user, who must be an owner, to admin, in one transaction. Each
// role change emits membership.upserted and audits member.role_changed.
// Transferring to oneself is ErrInvalid.
func (s *Service) TransferOwnership(ctx context.Context, user uuid.UUID, slug string, target uuid.UUID) error {
	if target == user {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return err
	}
	if org.Role != RoleOwner {
		return ErrForbidden
	}
	m, err := getMember(ctx, q, org.ID, target)
	if err != nil {
		return err
	}
	if m.Role != RoleOwner {
		if err := s.setRole(ctx, tx, user, org, target, m.Role, RoleOwner); err != nil {
			return err
		}
	}
	if err := s.setRole(ctx, tx, user, org, user, RoleOwner, RoleAdmin); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("orgs: commit: %w", err)
	}
	return nil
}

// setRole changes target's role from from to to inside tx, emitting
// membership.upserted and auditing member.role_changed by actor.
func (s *Service) setRole(ctx context.Context, tx pgx.Tx, actor uuid.UUID, org db.LockMemberOrganizationRow, target uuid.UUID, from, to string) error {
	if _, err := db.New(tx).UpdateMembershipRole(ctx, db.UpdateMembershipRoleParams{OrgID: org.ID, UserID: target, Role: to}); err != nil {
		return fmt.Errorf("orgs: update role: %w", err)
	}
	if err := outbox.Emit(ctx, tx, outbox.MembershipUpserted, org.ID, outbox.MembershipUpsertedPayload{OrgID: org.ID, UserID: target, Role: to}); err != nil {
		return err
	}
	return s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:  &target,
		Actor: &actor,
		Kind:  audit.MemberRoleChanged,
		Meta:  map[string]any{"org_id": org.ID.String(), "slug": org.Slug, "from": from, "to": to},
	})
}

// ensureAnotherOwner returns ErrLastOwner unless the organization, whose row
// the transaction has locked, has more than one owner.
func ensureAnotherOwner(ctx context.Context, q *db.Queries, org uuid.UUID) error {
	n, err := q.CountOrgOwners(ctx, org)
	if err != nil {
		return fmt.Errorf("orgs: count owners: %w", err)
	}
	if n <= 1 {
		return ErrLastOwner
	}
	return nil
}

func getMember(ctx context.Context, q *db.Queries, org, user uuid.UUID) (db.GetOrgMemberRow, error) {
	m, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrgID: org, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrMemberNotFound
	}
	if err != nil {
		return m, fmt.Errorf("orgs: get member: %w", err)
	}
	return m, nil
}

func member(r db.GetOrgMemberRow) Member {
	return Member{
		UserID:      r.UserID,
		Email:       r.Email,
		Name:        r.Name,
		AvatarURL:   r.AvatarUrl,
		Role:        r.Role,
		JoinedAt:    r.CreatedAt,
		LastLoginAt: r.LastLoginAt,
	}
}
