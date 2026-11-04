//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestOrganizationMembershipAndInvitationQueries(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)

	newUser := func(email string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, id, email); err != nil {
			t.Fatal(err)
		}
		return id
	}
	owner, joiner := newUser("owner@acme.com"), newUser("dev@acme.com")

	// Organizations.
	org, err := q.CreateOrganization(ctx, db.CreateOrganizationParams{ID: uuid.New(), Slug: "acme", Name: "Acme", CreatedBy: &owner})
	if err != nil {
		t.Fatal(err)
	}
	if org.CreatedBy == nil || *org.CreatedBy != owner || org.DomainJoin || len(org.AllowedDomains) != 0 {
		t.Fatalf("created org = %+v", org)
	}
	if taken, err := q.OrganizationSlugTaken(ctx, "acme"); err != nil || !taken {
		t.Fatalf("slug taken = %v, %v; want true", taken, err)
	}
	if taken, err := q.OrganizationSlugTaken(ctx, "globex"); err != nil || taken {
		t.Fatalf("slug taken = %v, %v; want false", taken, err)
	}
	on := true
	org, err = q.UpdateOrganization(ctx, db.UpdateOrganizationParams{ID: org.ID, AllowedDomains: []string{"acme.com"}, DomainJoin: &on})
	if err != nil || org.Name != "Acme" || !org.DomainJoin || len(org.AllowedDomains) != 1 {
		t.Fatalf("update = %+v, %v; name must be unchanged", org, err)
	}

	// Memberships.
	if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: org.ID, UserID: owner, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	joinable, err := q.ListJoinableOrganizations(ctx, db.ListJoinableOrganizationsParams{Domain: "acme.com", UserID: joiner})
	if err != nil || len(joinable) != 1 || joinable[0].ID != org.ID {
		t.Fatalf("joinable for joiner = %+v, %v", joinable, err)
	}
	if joinable, err := q.ListJoinableOrganizations(ctx, db.ListJoinableOrganizationsParams{Domain: "acme.com", UserID: owner}); err != nil || len(joinable) != 0 {
		t.Fatalf("members must not see their own org as joinable: %+v, %v", joinable, err)
	}
	if joinable, err := q.ListJoinableOrganizations(ctx, db.ListJoinableOrganizationsParams{Domain: "globex.com", UserID: joiner}); err != nil || len(joinable) != 0 {
		t.Fatalf("other domains = %+v, %v; want none", joinable, err)
	}
	if _, err := q.CreateMembership(ctx, db.CreateMembershipParams{OrgID: org.ID, UserID: joiner, Role: "member", InvitedBy: &owner}); err != nil {
		t.Fatal(err)
	}
	orgs, err := q.ListUserOrganizations(ctx, joiner)
	if err != nil || len(orgs) != 1 || orgs[0].Slug != "acme" || orgs[0].Role != "member" {
		t.Fatalf("user orgs = %+v, %v", orgs, err)
	}
	members, err := q.ListOrgMembers(ctx, org.ID)
	if err != nil || len(members) != 2 || members[0].Email != "owner@acme.com" {
		t.Fatalf("members = %+v, %v", members, err)
	}

	// The last-owner rule as the service layer applies it: lock, count, decide.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	qtx := q.WithTx(tx)
	if _, err := qtx.LockOrganization(ctx, org.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := qtx.CountOrgOwners(ctx, org.ID); err != nil || n != 1 {
		t.Fatalf("owners = %d, %v; want 1", n, err)
	}
	m, err := qtx.UpdateMembershipRole(ctx, db.UpdateMembershipRoleParams{OrgID: org.ID, UserID: joiner, Role: "owner"})
	if err != nil || m.Role != "owner" {
		t.Fatalf("promote = %+v, %v", m, err)
	}
	if n, err := qtx.DeleteMembership(ctx, db.DeleteMembershipParams{OrgID: org.ID, UserID: owner}); err != nil || n != 1 {
		t.Fatalf("delete membership = %d, %v", n, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := q.GetMembership(ctx, db.GetMembershipParams{OrgID: org.ID, UserID: owner}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("removed membership = %v; want ErrNoRows", err)
	}

	// Invitations: create, look up, resend, accept, revoke.
	inv, err := q.CreateInvitation(ctx, db.CreateInvitationParams{
		ID: uuid.New(), OrgID: org.ID, Email: "New@acme.com", Role: "viewer", TokenHash: "h1",
		InvitedBy: &joiner, ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateInvitation(ctx, db.CreateInvitationParams{
		ID: uuid.New(), OrgID: org.ID, Email: "new@ACME.com", Role: "viewer", TokenHash: "h2",
		ExpiresAt: time.Now().Add(time.Hour),
	}); err == nil {
		t.Fatal("a second pending invitation for the same address should fail")
	}
	byHash, err := q.GetInvitationByTokenHash(ctx, "h1")
	if err != nil || byHash.ID != inv.ID || byHash.OrgSlug != "acme" {
		t.Fatalf("by hash = %+v, %v", byHash, err)
	}
	resent, err := q.ResendInvitation(ctx, db.ResendInvitationParams{ID: inv.ID, OrgID: org.ID, TokenHash: "h3", ExpiresAt: time.Now().Add(7 * 24 * time.Hour)})
	if err != nil || resent.ResentAt == nil || resent.TokenHash != "h3" {
		t.Fatalf("resend = %+v, %v", resent, err)
	}
	if _, err := q.GetInvitationByTokenHash(ctx, "h1"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("old token after resend = %v; want ErrNoRows", err)
	}
	if pending, err := q.ListPendingInvitations(ctx, org.ID); err != nil || len(pending) != 1 {
		t.Fatalf("pending = %+v, %v; want 1", pending, err)
	}
	accepted, err := q.AcceptInvitation(ctx, inv.ID)
	if err != nil || accepted.AcceptedAt == nil {
		t.Fatalf("accept = %+v, %v", accepted, err)
	}
	if _, err := q.AcceptInvitation(ctx, inv.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("second accept = %v; want ErrNoRows", err)
	}
	if _, err := q.RevokeInvitation(ctx, db.RevokeInvitationParams{ID: inv.ID, OrgID: org.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("revoking an accepted invitation = %v; want ErrNoRows", err)
	}
	expired, err := q.CreateInvitation(ctx, db.CreateInvitationParams{
		ID: uuid.New(), OrgID: org.ID, Email: "late@acme.com", Role: "member", TokenHash: "h4",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE invitations SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1`, expired.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AcceptInvitation(ctx, expired.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("accepting an expired invitation = %v; want ErrNoRows", err)
	}
	if revoked, err := q.RevokeInvitation(ctx, db.RevokeInvitationParams{ID: expired.ID, OrgID: org.ID}); err != nil || revoked.RevokedAt == nil {
		t.Fatalf("revoke = %+v, %v", revoked, err)
	}
	if pending, err := q.ListPendingInvitations(ctx, org.ID); err != nil || len(pending) != 0 {
		t.Fatalf("pending after accept and revoke = %+v, %v; want none", pending, err)
	}

	// Soft-deleting the organization hides it everywhere.
	if n, err := q.SoftDeleteOrganization(ctx, org.ID); err != nil || n != 1 {
		t.Fatalf("soft delete = %d, %v", n, err)
	}
	if orgs, err := q.ListUserOrganizations(ctx, joiner); err != nil || len(orgs) != 0 {
		t.Fatalf("user orgs after delete = %+v, %v; want none", orgs, err)
	}
	if _, err := q.LockOrganization(ctx, org.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("lock deleted org = %v; want ErrNoRows", err)
	}
}
