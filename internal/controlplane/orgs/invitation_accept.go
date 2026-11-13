package orgs

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// MaxInvitationTokenLen bounds the invitation tokens looked up; issued ones
// are 43 characters.
const MaxInvitationTokenLen = 128

// Errors returned by Lookup and Accept.
var (
	// ErrInvitationTokenInvalid: no invitation has the token (it was never
	// issued, was rotated by a resend, or its organization is gone).
	ErrInvitationTokenInvalid = errors.New("orgs: invalid invitation token")
	// ErrInvitationExpired: the invitation exists but has expired, was
	// revoked, or was accepted by an account that is no longer a member.
	ErrInvitationExpired = errors.New("orgs: invitation expired")
	// ErrInviteEmailMismatch: the accepting user's verified email is not the
	// invited address (or their email is not verified).
	ErrInviteEmailMismatch = errors.New("orgs: invitation email mismatch")
)

// InvitationPreview is what the public invitation page shows before the
// invitee signs in.
type InvitationPreview struct {
	OrgName     string
	OrgSlug     string
	InviterName string
	EmailMasked string
	Role        string
	ExpiresAt   time.Time
}

// AcceptedInvitation is the organization an accepted invitation made the
// user a member of, with their role there. Joined reports whether this call
// added the membership.
type AcceptedInvitation struct {
	Org    Org
	Joined bool
}

// MaskEmail hides most of the local part of addr, keeping its first
// character and the domain: "ada@example.com" → "a***@example.com".
func MaskEmail(addr string) string {
	at := strings.LastIndexByte(addr, '@')
	if at <= 0 {
		return "***"
	}
	first := []rune(addr[:at])[0]
	return string(first) + "***" + addr[at:]
}

// Lookup returns the preview of the pending invitation with the raw token.
// An unknown token is ErrInvitationTokenInvalid; an expired, revoked or
// accepted invitation is ErrInvitationExpired.
func (s *InvitationService) Lookup(ctx context.Context, token string) (InvitationPreview, error) {
	if token == "" || len(token) > MaxInvitationTokenLen {
		return InvitationPreview{}, ErrInvitationTokenInvalid
	}
	q := db.New(s.pool)
	inv, err := q.GetInvitationByTokenHash(ctx, HashInvitationToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return InvitationPreview{}, ErrInvitationTokenInvalid
	}
	if err != nil {
		return InvitationPreview{}, fmt.Errorf("orgs: get invitation: %w", err)
	}
	if inv.AcceptedAt != nil || inv.RevokedAt != nil || !inv.ExpiresAt.After(s.now()) {
		return InvitationPreview{}, ErrInvitationExpired
	}
	var inviter string
	if inv.InvitedBy != nil {
		u, err := q.GetInviter(ctx, *inv.InvitedBy)
		switch {
		case err == nil:
			inviter = u.Name
			if strings.TrimSpace(inviter) == "" {
				// The invitation email names the inviter the same way.
				inviter = u.Email
			}
		case !errors.Is(err, pgx.ErrNoRows):
			return InvitationPreview{}, fmt.Errorf("orgs: get inviter: %w", err)
		}
	}
	return InvitationPreview{
		OrgName:     inv.OrgName,
		OrgSlug:     inv.OrgSlug,
		InviterName: inviter,
		EmailMasked: MaskEmail(inv.Email),
		Role:        inv.Role,
		ExpiresAt:   inv.ExpiresAt,
	}, nil
}

// Accept accepts the invitation with the raw token on behalf of user, whose
// verified email must be the invited address (ErrInviteEmailMismatch). The
// invitation is marked accepted and user becomes a member with its role; the
// membership, its membership.upserted outbox row and the invitation.accepted
// audit event are written in one transaction. A user who already belongs to
// the organization keeps their role. Accepting an invitation user already
// accepted changes nothing and returns the organization again (Joined
// false). An unknown token is ErrInvitationTokenInvalid; an expired or
// revoked invitation is ErrInvitationExpired.
func (s *InvitationService) Accept(ctx context.Context, user uuid.UUID, token string) (AcceptedInvitation, error) {
	if token == "" || len(token) > MaxInvitationTokenLen {
		return AcceptedInvitation{}, ErrInvitationTokenInvalid
	}
	hash := HashInvitationToken(token)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	inv, err := q.GetInvitationByTokenHash(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptedInvitation{}, ErrInvitationTokenInvalid
	}
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: get invitation: %w", err)
	}
	u, err := q.GetUserEmail(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptedInvitation{}, ErrUserGone
	}
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: get user: %w", err)
	}
	if u.EmailVerifiedAt == nil || !strings.EqualFold(u.Email, inv.Email) {
		return AcceptedInvitation{}, ErrInviteEmailMismatch
	}
	// Serialize with other membership writes of the organization (domain
	// join, other accepts) so the membership is created at most once.
	o, err := q.LockOrganizationBySlug(ctx, inv.OrgSlug)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptedInvitation{}, ErrInvitationTokenInvalid
	}
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: lock organization: %w", err)
	}
	org := Org{ID: o.ID, Slug: o.Slug, Name: o.Name, CreatedAt: o.CreatedAt}
	if _, err := q.AcceptInvitation(ctx, inv.ID); errors.Is(err, pgx.ErrNoRows) {
		// Not pending: already accepted (idempotent while still a member),
		// revoked or expired. The lock makes this read current.
		return s.notAccepted(ctx, q, org, user, hash)
	} else if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: accept invitation: %w", err)
	}
	m, err := q.GetMembership(ctx, db.GetMembershipParams{OrgID: o.ID, UserID: user})
	joined := false
	switch {
	case err == nil:
		// Already a member (e.g. joined by email domain): keep their role.
		org.Role = m.Role
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: o.ID, UserID: user, Role: inv.Role, InvitedBy: inv.InvitedBy}); err != nil {
			return AcceptedInvitation{}, fmt.Errorf("orgs: create membership: %w", err)
		}
		if err := outbox.Emit(ctx, tx, outbox.MembershipUpserted, o.ID, outbox.MembershipUpsertedPayload{OrgID: o.ID, UserID: user, Role: inv.Role}); err != nil {
			return AcceptedInvitation{}, err
		}
		org.Role, joined = inv.Role, true
	default:
		return AcceptedInvitation{}, fmt.Errorf("orgs: get membership: %w", err)
	}
	if err := s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		User:   &user,
		Actor:  &user,
		Kind:   audit.InvitationAccepted,
		Org:    &o.ID,
		Target: audit.Target{Type: "invitation", ID: inv.ID.String(), Label: u.Email},
		Meta: map[string]any{
			"org_id": o.ID.String(), "slug": o.Slug, "invitation_id": inv.ID.String(),
			"role": org.Role, "invited_role": inv.Role, "joined": joined,
		},
	}); err != nil {
		return AcceptedInvitation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: commit: %w", err)
	}
	return AcceptedInvitation{Org: org, Joined: joined}, nil
}

// notAccepted explains why AcceptInvitation matched no row. An accepted
// invitation whose invitee is still a member answers the organization again,
// so accepting twice is harmless.
func (s *InvitationService) notAccepted(ctx context.Context, q *db.Queries, org Org, user uuid.UUID, hash string) (AcceptedInvitation, error) {
	inv, err := q.GetInvitationByTokenHash(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptedInvitation{}, ErrInvitationTokenInvalid
	}
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: get invitation: %w", err)
	}
	if inv.AcceptedAt == nil {
		return AcceptedInvitation{}, ErrInvitationExpired
	}
	m, err := q.GetMembership(ctx, db.GetMembershipParams{OrgID: org.ID, UserID: user})
	if errors.Is(err, pgx.ErrNoRows) {
		return AcceptedInvitation{}, ErrInvitationExpired
	}
	if err != nil {
		return AcceptedInvitation{}, fmt.Errorf("orgs: get membership: %w", err)
	}
	org.Role = m.Role
	return AcceptedInvitation{Org: org}, nil
}
