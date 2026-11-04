package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
)

// DevUserEmail is the user `apilens seed` makes owner of the seeded
// organization.
const DevUserEmail = "dev@apilens.local"

// Errors of the operator user commands.
var (
	// ErrInvalidMember: the email is empty or the role is unknown.
	ErrInvalidMember = errors.New("bootstrap: invalid email or role")
	// ErrUserNotFound: no active user has the email.
	ErrUserNotFound = errors.New("bootstrap: user not found")
	// ErrOrgNotFound: no active organization has the slug.
	ErrOrgNotFound = errors.New("bootstrap: organization not found")
	// ErrLastOwner: the change would leave the organization without an owner.
	ErrLastOwner = errors.New("bootstrap: the organization's last owner cannot be demoted")
)

// MemberOptions names the user, organization and role of EnsureMember.
type MemberOptions struct {
	Email   string
	OrgSlug string
	Role    string
	// Create creates the user when no active user has Email. Without it a
	// missing user is ErrUserNotFound.
	Create bool
}

// MemberResult is printed by `apilens user create|promote`.
type MemberResult struct {
	UserID      uuid.UUID `json:"user_id"`
	Email       string    `json:"email"`
	UserCreated bool      `json:"user_created"`
	OrgID       uuid.UUID `json:"org_id"`
	OrgSlug     string    `json:"org_slug"`
	Role        string    `json:"role"`
	// PreviousRole is the role before this change; empty when the user just
	// joined the organization.
	PreviousRole string `json:"previous_role,omitempty"`
}

// EnsureMember makes the user with o.Email a member of organization
// o.OrgSlug with role o.Role, creating the user first when o.Create is set.
// A new membership emits membership.upserted and audits member.added; a role
// change emits membership.upserted and audits member.role_changed; an
// unchanged role writes nothing. The actor of the audit events is the system
// (the operator running the CLI), and the last owner is never demoted.
func EnsureMember(ctx context.Context, pool *pgxpool.Pool, o MemberOptions) (MemberResult, error) {
	email := strings.TrimSpace(o.Email)
	if !strings.Contains(email, "@") || !orgs.ValidRole(o.Role) {
		return MemberResult{}, ErrInvalidMember
	}
	var (
		user    identitydb.User
		created bool
		err     error
	)
	if o.Create {
		user, created, err = users.New(pool).FindOrCreateByVerifiedEmail(ctx, email, users.SourceOperator)
	} else {
		user, err = identitydb.New(pool).GetUserByEmail(ctx, email)
		if errors.Is(err, pgx.ErrNoRows) {
			return MemberResult{}, ErrUserNotFound
		}
	}
	if err != nil {
		return MemberResult{}, fmt.Errorf("user: %w", err)
	}
	res := MemberResult{UserID: user.ID, Email: user.Email, UserCreated: created, OrgSlug: o.OrgSlug, Role: o.Role}
	recorder := audit.New(pool)
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		q := db.New(tx)
		org, err := q.GetOrganizationBySlug(ctx, o.OrgSlug)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrOrgNotFound
		}
		if err != nil {
			return fmt.Errorf("organization: %w", err)
		}
		// The lock serialises this with every other membership change of the
		// organization, so the last-owner check below holds at commit.
		if _, err := q.LockOrganization(ctx, org.ID); err != nil {
			return fmt.Errorf("lock organization: %w", err)
		}
		res.OrgID = org.ID
		actx := audit.WithTx(ctx, tx)
		meta := map[string]any{"org_id": org.ID.String(), "slug": org.Slug, "method": "cli"}
		m, err := q.GetMembership(ctx, db.GetMembershipParams{OrgID: org.ID, UserID: user.ID})
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: org.ID, UserID: user.ID, Role: o.Role}); err != nil {
				return fmt.Errorf("membership: %w", err)
			}
			meta["role"] = o.Role
			if err := emitMembership(ctx, tx, org.ID, user.ID, o.Role); err != nil {
				return err
			}
			return recorder.Record(actx, audit.Event{User: &user.ID, Kind: audit.MemberAdded, Meta: meta})
		case err != nil:
			return fmt.Errorf("membership: %w", err)
		}
		res.PreviousRole = m.Role
		if m.Role == o.Role {
			return nil
		}
		if m.Role == orgs.RoleOwner {
			n, err := q.CountOrgOwners(ctx, org.ID)
			if err != nil {
				return fmt.Errorf("count owners: %w", err)
			}
			if n <= 1 {
				return ErrLastOwner
			}
		}
		if _, err := q.UpdateMembershipRole(ctx, db.UpdateMembershipRoleParams{OrgID: org.ID, UserID: user.ID, Role: o.Role}); err != nil {
			return fmt.Errorf("membership role: %w", err)
		}
		if err := emitMembership(ctx, tx, org.ID, user.ID, o.Role); err != nil {
			return err
		}
		meta["from"], meta["to"] = m.Role, o.Role
		return recorder.Record(actx, audit.Event{User: &user.ID, Kind: audit.MemberRoleChanged, Meta: meta})
	})
	if err != nil {
		return MemberResult{}, err
	}
	return res, nil
}

func emitMembership(ctx context.Context, tx pgx.Tx, org, user uuid.UUID, role string) error {
	return outbox.Emit(ctx, tx, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: role})
}

// MagicLinkResult is printed by `apilens user magic-link` (and by seed). The
// link is a bearer secret, shown once.
type MagicLinkResult struct {
	UserID    uuid.UUID `json:"user_id"`
	Email     string    `json:"email"`
	MagicLink string    `json:"magic_link"`
	ExpiresAt time.Time `json:"expires_at"`
}

// MagicLink issues a sign-in link for the existing user with email, without
// sending any email, and audits login.requested (method "cli"). The link
// opens {uiURL}/verify like an emailed one; it lives emailauth.TTL, works
// once and supersedes every earlier unused email of the address.
func MagicLink(ctx context.Context, pool *pgxpool.Pool, uiURL, email string) (MagicLinkResult, error) {
	user, err := identitydb.New(pool).GetUserByEmail(ctx, strings.TrimSpace(email))
	if errors.Is(err, pgx.ErrNoRows) {
		return MagicLinkResult{}, ErrUserNotFound
	}
	if err != nil {
		return MagicLinkResult{}, fmt.Errorf("user: %w", err)
	}
	issued, err := emailauth.New(emailauth.NewStore(pool), emailauth.Options{}).
		Issue(ctx, user.Email, emailauth.IntentSignIn, emailauth.IssueOptions{UserID: &user.ID, UserAgent: "apilens-cli"})
	if err != nil {
		return MagicLinkResult{}, fmt.Errorf("issue link: %w", err)
	}
	if err := audit.New(pool).Record(ctx, audit.Event{
		User: &user.ID,
		Kind: audit.LoginRequested,
		Meta: map[string]any{"method": "cli", "intent": string(emailauth.IntentSignIn), "email": user.Email, "email_sent": false},
	}); err != nil {
		return MagicLinkResult{}, err
	}
	q := url.Values{"token": {issued.LinkToken}, "email": {user.Email}}
	return MagicLinkResult{
		UserID:    user.ID,
		Email:     user.Email,
		MagicLink: strings.TrimRight(uiURL, "/") + "/verify?" + q.Encode(),
		ExpiresAt: issued.Row.ExpiresAt,
	}, nil
}
