//go:build integration

package controlplane_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestProjectAuditEvents changes a project, its environments, its privacy
// policy, an org invitation and apps through the services and checks that
// each change records its audit event with the org and project scope, the
// target, the actor and the previous and next values of what changed.
func TestProjectAuditEvents(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	rec := audit.New(pool)

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	checkout, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "checkout", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	owner := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, 'owner@example.com')`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, seed.OrgID, owner); err != nil {
		t.Fatal(err)
	}

	// last returns the changes of the newest event of kind after checking
	// its scope (project uuid.Nil: org-wide), actor and target.
	last := func(kind audit.Kind, project uuid.UUID, targetType, targetID string) (prev, next map[string]any) {
		t.Helper()
		var (
			org, proj, actor *uuid.UUID
			typ, id          *string
			changes          []byte
		)
		err := pool.QueryRow(ctx, `SELECT org_id, project_id, actor_user_id, target_type, target_id, changes
			FROM audit_events WHERE event = $1 ORDER BY id DESC LIMIT 1`, string(kind)).
			Scan(&org, &proj, &actor, &typ, &id, &changes)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if org == nil || *org != seed.OrgID || actor == nil || *actor != owner {
			t.Fatalf("%s: org %v actor %v", kind, org, actor)
		}
		if (project == uuid.Nil) != (proj == nil) || (proj != nil && *proj != project) {
			t.Fatalf("%s: project %v, want %v", kind, proj, project)
		}
		if typ == nil || *typ != targetType || id == nil || *id != targetID {
			t.Fatalf("%s target: %v %v, want %s %s", kind, typ, id, targetType, targetID)
		}
		var c struct {
			Previous map[string]any `json:"previous"`
			Next     map[string]any `json:"next"`
		}
		if err := json.Unmarshal(changes, &c); err != nil {
			t.Fatalf("%s changes %s: %v", kind, changes, err)
		}
		return c.Previous, c.Next
	}

	// Projects and environments.
	ps := projects.New(pool).WithAudit(rec)
	p, err := ps.Create(ctx, owner, "acme", "Billing", "billing", []string{"production"})
	if err != nil {
		t.Fatal(err)
	}
	prev, next := last(audit.ProjectCreated, p.ID, "project", p.ID.String())
	if prev != nil || next["name"] != "Billing" || next["slug"] != "billing" {
		t.Fatalf("project.created = %v -> %v", prev, next)
	}
	name := "Billing API"
	if _, err := ps.Update(ctx, owner, "billing", projects.Update{Name: &name}); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.ProjectUpdated, p.ID, "project", p.ID.String())
	if prev["name"] != "Billing" || next["name"] != "Billing API" {
		t.Fatalf("project.updated = %v -> %v", prev, next)
	}
	if _, err := ps.AddEnvironment(ctx, owner, "billing", "staging"); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.EnvironmentAdded, p.ID, "environment", "staging")
	if prev != nil || next["name"] != "staging" {
		t.Fatalf("environment.added = %v -> %v", prev, next)
	}
	if _, err := ps.RemoveEnvironment(ctx, owner, "billing", "staging"); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.EnvironmentRemoved, p.ID, "environment", "staging")
	if prev["name"] != "staging" || next != nil {
		t.Fatalf("environment.removed = %v -> %v", prev, next)
	}
	// No-op writes record nothing.
	var before, after int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&before)
	if _, err := ps.Update(ctx, owner, "billing", projects.Update{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if _, err := ps.RemoveEnvironment(ctx, owner, "billing", "staging"); err != nil {
		t.Fatal(err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&after)
	if after != before {
		t.Fatalf("no-op writes recorded %d events", after-before)
	}

	// Privacy policy, project-wide.
	if _, err := privacy.NewService(pool).WithAudit(rec).Put(ctx, owner, "billing", "", privacy.Policy{Headers: []string{"x-session"}}); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.PrivacyPolicyUpdated, p.ID, "project", p.ID.String())
	if h, _ := next["headers"].([]any); len(h) != 1 || h[0] != "x-session" || len(prev) != 1 {
		t.Fatalf("privacy_policy.updated = %v -> %v", prev, next)
	}

	// Invitation revoke (org-wide).
	inv := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by)
		VALUES ($1, $2, 'new@example.com', 'member', 'hash-of-a-test-token', $3)`, inv, seed.OrgID, owner); err != nil {
		t.Fatal(err)
	}
	if err := orgs.NewInvitations(pool, rec, nil).Revoke(ctx, owner, "acme", inv); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.InvitationRevoked, uuid.Nil, "invitation", inv.String())
	if prev["status"] != "pending" || next["status"] != "revoked" {
		t.Fatalf("invitation.revoked = %v -> %v", prev, next)
	}

	// Apps.
	as := apps.NewService(pool, rec)
	app := seed.AppID.String()
	if err := as.Rename(ctx, owner, seed.ProjectID, seed.AppID, "Store front"); err != nil {
		t.Fatal(err)
	}
	if prev, next = last(audit.AppRenamed, seed.ProjectID, "app", app); prev["name"] != "Storefront" || next["name"] != "Store front" {
		t.Fatalf("app.renamed = %v -> %v", prev, next)
	}
	if err := as.Archive(ctx, owner, seed.ProjectID, seed.AppID); err != nil {
		t.Fatal(err)
	}
	if prev, next = last(audit.AppArchived, seed.ProjectID, "app", app); prev["state"] != "active" || next["state"] != "archived" {
		t.Fatalf("app.archived = %v -> %v", prev, next)
	}
	if err := as.Restore(ctx, owner, seed.ProjectID, seed.AppID); err != nil {
		t.Fatal(err)
	}
	if prev, next = last(audit.AppRestored, seed.ProjectID, "app", app); prev["state"] != "archived" || next["state"] != "active" {
		t.Fatalf("app.restored = %v -> %v", prev, next)
	}
	if err := as.Merge(ctx, owner, seed.ProjectID, checkout.AppID, seed.AppID); err != nil {
		t.Fatal(err)
	}
	prev, next = last(audit.AppMerged, seed.ProjectID, "app", checkout.AppID.String())
	if prev["state"] != "active" || next["state"] != "merged" || next["merged_into"] != "storefront" {
		t.Fatalf("app.merged = %v -> %v", prev, next)
	}
	if err := as.Delete(ctx, owner, seed.ProjectID, seed.AppID); err != nil {
		t.Fatal(err)
	}
	if prev, next = last(audit.AppDeleted, seed.ProjectID, "app", app); prev["state"] != "active" || next["state"] != "deleted" {
		t.Fatalf("app.deleted = %v -> %v", prev, next)
	}
}
