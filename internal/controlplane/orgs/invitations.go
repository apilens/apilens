package orgs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Invitation limits.
const (
	// MaxInvites bounds the addresses invited in one call.
	MaxInvites = 50
	// InvitationTTL is how long an emailed invitation stays usable; a resend
	// starts it again.
	InvitationTTL = 7 * 24 * time.Hour
	// ResendCooldown is the least time between two emails of one invitation.
	ResendCooldown = 5 * time.Minute
	// maxEmailLen matches invitations.email.
	maxEmailLen = 320
	// invitationTokenBytes is the entropy of an invitation token.
	invitationTokenBytes = 32
)

// InviteRoles are the roles an invitation may grant: owner is only ever
// transferred, never invited.
var InviteRoles = []string{RoleAdmin, RoleMember, RoleViewer}

// Errors returned by InvitationService besides ErrNotFound, ErrForbidden and
// ErrInvalid.
var (
	// ErrInvitationNotFound: the organization has no pending invitation with
	// the id (it was accepted, revoked or never existed).
	ErrInvitationNotFound = errors.New("orgs: invitation not found")
)

// ResendCooldownError is returned by Resend while the invitation was sent
// less than ResendCooldown ago; RetryAfter is the remaining wait.
type ResendCooldownError struct {
	RetryAfter time.Duration
}

func (e *ResendCooldownError) Error() string { return "orgs: invitation resent too recently" }

// Outcomes of one address in an Invite call.
const (
	// InviteSent: a new invitation was created and emailed.
	InviteSent = "invited"
	// InviteReplaced: the address's pending invitation was revoked and a new
	// one created and emailed.
	InviteReplaced = "replaced"
	// InviteAlreadyMember: the address belongs to a member; nothing sent.
	InviteAlreadyMember = "already_member"
	// InviteDuplicate: the address appeared earlier in the same call.
	InviteDuplicate = "duplicate"
)

// Enqueuer enqueues background jobs in a transaction; *jobs.Client
// satisfies it.
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// Invite is one address to invite with the role it would join with.
type Invite struct {
	Email string
	Role  string
}

// Invitation is a pending invitation to an organization.
type Invitation struct {
	ID           uuid.UUID
	Email        string
	Role         string
	InvitedBy    *uuid.UUID
	InviterEmail string
	InviterName  string
	CreatedAt    time.Time
	ExpiresAt    time.Time
	ResentAt     *time.Time
}

// InviteResult is the outcome of one address of an Invite call; Invitation
// is set when an email was sent (InviteSent, InviteReplaced).
type InviteResult struct {
	Email      string
	Status     string
	Invitation *Invitation
}

// InvitationService creates, lists, resends and revokes the invitations of
// organizations. Every email is enqueued in the transaction that writes the
// invitation, so it goes out only if the invitation exists.
type InvitationService struct {
	pool  *pgxpool.Pool
	audit Auditor
	jobs  Enqueuer
	now   func() time.Time
}

// NewInvitations returns an InvitationService over pool.
func NewInvitations(pool *pgxpool.Pool, auditor Auditor, jobs Enqueuer) *InvitationService {
	return &InvitationService{pool: pool, audit: auditor, jobs: jobs, now: time.Now}
}

// NormalizeInviteEmail trims addr and reports whether it is a bare email
// address an invitation can be sent to.
func NormalizeInviteEmail(addr string) (string, bool) {
	addr = strings.TrimSpace(addr)
	if addr == "" || len(addr) > maxEmailLen {
		return "", false
	}
	a, err := mail.ParseAddress(addr)
	if err != nil || a.Address != addr || a.Name != "" {
		return "", false
	}
	return addr, true
}

// Invite invites each address to the organization slug on behalf of user,
// who must be an owner or admin. Addresses of members are skipped
// (InviteAlreadyMember); an address with a pending invitation gets a new one
// in its place (InviteReplaced). Each sent invitation is emailed and audited
// as invitation.sent. One result is returned per address, in order. More
// than MaxInvites addresses, an invalid address or a role outside
// InviteRoles is ErrInvalid and invites nobody.
func (s *InvitationService) Invite(ctx context.Context, user uuid.UUID, slug string, invites []Invite) ([]InviteResult, error) {
	if len(invites) == 0 || len(invites) > MaxInvites {
		return nil, ErrInvalid
	}
	clean := make([]Invite, len(invites))
	for i, in := range invites {
		addr, ok := NormalizeInviteEmail(in.Email)
		if !ok || !slices.Contains(InviteRoles, in.Role) {
			return nil, ErrInvalid
		}
		clean[i] = Invite{Email: addr, Role: in.Role}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return nil, err
	}
	if !CanManage(org.Role) {
		return nil, ErrForbidden
	}
	inviter, err := getMember(ctx, q, org.ID, user)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(clean))
	out := make([]InviteResult, 0, len(clean))
	for _, in := range clean {
		key := strings.ToLower(in.Email)
		if seen[key] {
			out = append(out, InviteResult{Email: in.Email, Status: InviteDuplicate})
			continue
		}
		seen[key] = true
		member, err := q.OrgMemberEmailExists(ctx, db.OrgMemberEmailExistsParams{OrgID: org.ID, Email: in.Email})
		if err != nil {
			return nil, fmt.Errorf("orgs: check member email: %w", err)
		}
		if member {
			out = append(out, InviteResult{Email: in.Email, Status: InviteAlreadyMember})
			continue
		}
		replaced, err := q.RevokePendingInvitationByEmail(ctx, db.RevokePendingInvitationByEmailParams{OrgID: org.ID, Email: in.Email})
		if err != nil {
			return nil, fmt.Errorf("orgs: revoke pending invitation: %w", err)
		}
		raw, hash, err := newInvitationToken()
		if err != nil {
			return nil, err
		}
		row, err := q.CreateInvitation(ctx, db.CreateInvitationParams{
			ID:        uuid.New(),
			OrgID:     org.ID,
			Email:     in.Email,
			Role:      in.Role,
			TokenHash: hash,
			InvitedBy: &user,
			ExpiresAt: s.now().Add(InvitationTTL),
		})
		if err != nil {
			return nil, fmt.Errorf("orgs: create invitation: %w", err)
		}
		if err := s.send(ctx, tx, user, org, inviter, row.ID, row.Email, row.Role, raw, row.ExpiresAt, false); err != nil {
			return nil, err
		}
		status := InviteSent
		if replaced > 0 {
			status = InviteReplaced
		}
		inv := invitation(row, inviter)
		out = append(out, InviteResult{Email: in.Email, Status: status, Invitation: &inv})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("orgs: commit: %w", err)
	}
	return out, nil
}

// Pending lists the pending invitations of the organization slug, newest
// first, including expired ones that can still be resent. Owners and admins
// only.
func (s *InvitationService) Pending(ctx context.Context, user uuid.UUID, slug string) ([]Invitation, error) {
	q := db.New(s.pool)
	org, err := q.GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("orgs: get: %w", err)
	}
	if !CanManage(org.Role) {
		return nil, ErrForbidden
	}
	rows, err := q.ListPendingInvitationsWithInviter(ctx, org.ID)
	if err != nil {
		return nil, fmt.Errorf("orgs: list invitations: %w", err)
	}
	out := make([]Invitation, 0, len(rows))
	for _, r := range rows {
		out = append(out, Invitation{
			ID:           r.ID,
			Email:        r.Email,
			Role:         r.Role,
			InvitedBy:    r.InvitedBy,
			InviterEmail: deref(r.InviterEmail),
			InviterName:  deref(r.InviterName),
			CreatedAt:    r.CreatedAt,
			ExpiresAt:    r.ExpiresAt,
			ResentAt:     r.ResentAt,
		})
	}
	return out, nil
}

// Resend emails the pending invitation id of the organization slug again on
// behalf of user, who must be an owner or admin, with a new token and a new
// expiry; the previous link stops working. Within ResendCooldown of the last
// email it returns *ResendCooldownError. It audits invitation.sent.
func (s *InvitationService) Resend(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) (Invitation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Invitation{}, fmt.Errorf("orgs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	org, err := lockMember(ctx, q, user, slug)
	if err != nil {
		return Invitation{}, err
	}
	if !CanManage(org.Role) {
		return Invitation{}, ErrForbidden
	}
	inviter, err := getMember(ctx, q, org.ID, user)
	if err != nil {
		return Invitation{}, err
	}
	raw, hash, err := newInvitationToken()
	if err != nil {
		return Invitation{}, err
	}
	now := s.now()
	sentBefore := now.Add(-ResendCooldown)
	row, err := q.ResendInvitation(ctx, db.ResendInvitationParams{
		TokenHash:  hash,
		ExpiresAt:  now.Add(InvitationTTL),
		ID:         id,
		OrgID:      org.ID,
		SentBefore: &sentBefore,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Invitation{}, s.notResent(ctx, q, org.ID, id, now)
	}
	if err != nil {
		return Invitation{}, fmt.Errorf("orgs: resend invitation: %w", err)
	}
	if err := s.send(ctx, tx, user, org, inviter, row.ID, row.Email, row.Role, raw, row.ExpiresAt, true); err != nil {
		return Invitation{}, err
	}
	inv := invitation(row, inviter)
	if row.InvitedBy != nil && *row.InvitedBy != user {
		// Resent by someone other than the original inviter, who stays the
		// invitation's inviter.
		orig, err := q.GetInviter(ctx, *row.InvitedBy)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Invitation{}, fmt.Errorf("orgs: get inviter: %w", err)
		}
		inv.InviterEmail, inv.InviterName = orig.Email, orig.Name
	}
	if err := tx.Commit(ctx); err != nil {
		return Invitation{}, fmt.Errorf("orgs: commit: %w", err)
	}
	return inv, nil
}

// notResent explains why ResendInvitation matched no row: the invitation is
// not pending, or it is in its cooldown.
func (s *InvitationService) notResent(ctx context.Context, q *db.Queries, org, id uuid.UUID, now time.Time) error {
	inv, err := q.GetInvitation(ctx, db.GetInvitationParams{ID: id, OrgID: org})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvitationNotFound
	}
	if err != nil {
		return fmt.Errorf("orgs: get invitation: %w", err)
	}
	if inv.AcceptedAt != nil || inv.RevokedAt != nil {
		return ErrInvitationNotFound
	}
	last := inv.CreatedAt
	if inv.ResentAt != nil {
		last = *inv.ResentAt
	}
	return &ResendCooldownError{RetryAfter: max(time.Second, last.Add(ResendCooldown).Sub(now))}
}

// Revoke revokes the pending invitation id of the organization slug on
// behalf of user, who must be an owner or admin; its link stops working.
func (s *InvitationService) Revoke(ctx context.Context, user uuid.UUID, slug string, id uuid.UUID) error {
	q := db.New(s.pool)
	org, err := q.GetMemberOrganization(ctx, db.GetMemberOrganizationParams{UserID: user, Slug: slug})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("orgs: get: %w", err)
	}
	if !CanManage(org.Role) {
		return ErrForbidden
	}
	_, err = q.RevokeInvitation(ctx, db.RevokeInvitationParams{ID: id, OrgID: org.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvitationNotFound
	}
	if err != nil {
		return fmt.Errorf("orgs: revoke invitation: %w", err)
	}
	return nil
}

// send enqueues the invitation email in tx and audits invitation.sent.
func (s *InvitationService) send(ctx context.Context, tx pgx.Tx, actor uuid.UUID, org db.LockMemberOrganizationRow, inviter db.GetOrgMemberRow, id uuid.UUID, to, role, token string, expires time.Time, resent bool) error {
	name := inviter.Name
	if strings.TrimSpace(name) == "" {
		name = inviter.Email
	}
	if _, err := s.jobs.InsertTx(ctx, tx, email.SendArgs{
		To:       to,
		Template: email.TemplateInvitation,
		Data: map[string]any{
			"org":        org.Name,
			"inviter":    name,
			"role":       role,
			"token":      token,
			"expires_at": expires.UTC().Format(time.RFC3339),
		},
	}, nil); err != nil {
		return fmt.Errorf("orgs: enqueue invitation email: %w", err)
	}
	return s.audit.Record(audit.WithTx(ctx, tx), audit.Event{
		Actor:  &actor,
		Kind:   audit.InvitationSent,
		Org:    &org.ID,
		Target: audit.Target{Type: "invitation", ID: id.String(), Label: to},
		Meta: map[string]any{
			"org_id": org.ID.String(), "slug": org.Slug, "invitation_id": id.String(),
			"email": to, "role": role, "resent": resent,
		},
	})
}

// newInvitationToken returns a fresh raw invitation token and its stored
// hash.
func newInvitationToken() (raw, hash string, err error) {
	b := make([]byte, invitationTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("orgs: invitation token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, HashInvitationToken(raw), nil
}

// HashInvitationToken is the stored form of an invitation token
// (invitations.token_hash): hex SHA-256.
func HashInvitationToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// invitation converts a row written or resent by inviter.
func invitation(r db.Invitation, inviter db.GetOrgMemberRow) Invitation {
	return Invitation{
		ID:           r.ID,
		Email:        r.Email,
		Role:         r.Role,
		InvitedBy:    r.InvitedBy,
		InviterEmail: inviter.Email,
		InviterName:  inviter.Name,
		CreatedAt:    r.CreatedAt,
		ExpiresAt:    r.ExpiresAt,
		ResentAt:     r.ResentAt,
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
