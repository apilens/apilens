//go:build integration

package outbox_test

import (
	"context"
	"testing"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	tu "github.com/apilens/apilens/internal/testutil"
)

func rel(resType, resID, relation, subType, subID string) *v1.Relationship {
	return &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: resType, ObjectId: resID},
		Relation: relation,
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: subType, ObjectId: subID}},
	}
}

// writeRels edits SpiceDB behind the relay's back and records the ZedToken
// for org, so the checks that follow see the edit.
func writeRels(t *testing.T, env relayEnv, org string, op v1.RelationshipUpdate_Operation, rels ...*v1.Relationship) {
	t.Helper()
	updates := make([]*v1.RelationshipUpdate, len(rels))
	for i, r := range rels {
		updates[i] = &v1.RelationshipUpdate{Operation: op, Relationship: r}
	}
	resp, err := env.sdb.WriteRelationships(context.Background(), &v1.WriteRelationshipsRequest{Updates: updates})
	if err != nil {
		t.Fatal(err)
	}
	if err := env.authz.RecordToken(context.Background(), org, resp.GetWrittenAt().GetToken()); err != nil {
		t.Fatal(err)
	}
}

func counter(t *testing.T, reg *prometheus.Registry, name, kind string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != name {
			continue
		}
		for _, m := range mf.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "kind" && l.GetValue() == kind {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

// subjectSet is resType:resID#relation@subType:subID#subRel.
func subjectSet(resType, resID, relation, subType, subID, subRel string) *v1.Relationship {
	r := rel(resType, resID, relation, subType, subID)
	r.Subject.OptionalRelation = subRel
	return r
}

func TestReconcilerRepairsDrift(t *testing.T) {
	env := newRelayEnv(t)
	ctx := context.Background()
	reg := prometheus.NewRegistry()
	rec := outbox.NewReconciler(env.pool, env.sdb, env.authz, outbox.ReconcileOptions{}, tu.Logger(t), reg)

	// Postgres: an org with an owner, a member and a viewer, a project in
	// it, and a direct Admin grant for the viewer, written with their outbox
	// rows and relayed to SpiceDB.
	org, owner, member, grantee, proj := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com'), ($2, 'member@example.com'), ($3, 'grantee@example.com')`, []any{owner, member, grantee}},
		{`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, []any{org}},
		{`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'viewer')`, []any{org, owner, member, grantee}},
		{`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'checkout', 'Checkout')`, []any{proj, org}},
		{`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')`, []any{proj, grantee}},
	} {
		if _, err := env.pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	emit(t, env.pool, outbox.OrgCreated, org, outbox.OrgCreatedPayload{OrgID: org, OwnerUserID: owner})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: member, Role: "member"})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: grantee, Role: "viewer"})
	emit(t, env.pool, outbox.ProjectCreated, proj, outbox.ProjectCreatedPayload{ProjectID: proj, OrgID: org})
	emit(t, env.pool, outbox.ProjectMemberUpserted, proj, outbox.ProjectMemberUpsertedPayload{ProjectID: proj, OrgID: org, UserID: grantee, Role: "admin"})
	if _, err := outbox.NewRelay(env.pool, env.sdb, env.authz, outbox.RelayOptions{}, tu.Logger(t), nil).Drain(ctx); err != nil {
		t.Fatal(err)
	}

	res, err := rec.Reconcile(ctx, false)
	if err != nil || res.Missing != 0 || res.Extra != 0 {
		t.Fatalf("in sync: %+v, %v", res, err)
	}

	check := func(u uuid.UUID, perm authz.Permission, res authz.Resource) bool {
		t.Helper()
		ok, err := env.authz.Check(ctx, authz.User(u.String()), perm, res)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	project := authz.Project(org.String(), proj.String())
	o, p := org.String(), proj.String()

	// Someone deletes relationships by hand: the member's role, the
	// project's org, its default relation for org members and the direct
	// project role.
	writeRels(t, env, o, v1.RelationshipUpdate_OPERATION_DELETE,
		rel(authz.TypeOrganization, o, "member", authz.TypeUser, member.String()),
		rel(authz.TypeProject, p, "org", authz.TypeOrganization, o),
		subjectSet(authz.TypeProject, p, "default_editor", authz.TypeOrganization, o, "member"),
		rel(authz.TypeProject, p, "admin", authz.TypeUser, grantee.String()))
	// ...and adds some Postgres has no source for, among them a project
	// role with no project_members row.
	stranger, sharee, ghost := uuid.New(), uuid.New(), uuid.New()
	writeRels(t, env, o, v1.RelationshipUpdate_OPERATION_TOUCH,
		rel(authz.TypeOrganization, o, "admin", authz.TypeUser, stranger.String()),
		rel(authz.TypeProject, ghost.String(), "org", authz.TypeOrganization, o),
		rel(authz.TypeProject, p, "viewer", authz.TypeUser, sharee.String()))
	if check(member, authz.ProjectEdit, project) {
		t.Fatal("member can still edit after the relationship was deleted")
	}
	if check(grantee, authz.ProjectManageAccess, project) {
		t.Fatal("grantee is still project admin after the relationship was deleted")
	}
	if !check(stranger, authz.OrgManage, authz.Organization(o)) {
		t.Fatal("stranger cannot manage after the relationship was added")
	}
	if !check(sharee, authz.ProjectView, project) {
		t.Fatal("sharee cannot view after the relationship was added")
	}

	// A dry run reports the drift and repairs nothing.
	res, err = rec.Reconcile(ctx, true)
	if err != nil || res.Missing != 4 || res.Extra != 3 || !res.DryRun {
		t.Fatalf("dry run: %+v, %v", res, err)
	}
	if check(member, authz.ProjectEdit, project) {
		t.Fatal("dry run repaired drift")
	}
	if got := counter(t, reg, "apilens_authz_drift_total", "missing"); got != 0 {
		t.Fatalf("dry run counted drift: %v", got)
	}

	// The real run restores the deleted relationships and removes the
	// strays.
	res, err = rec.Reconcile(ctx, false)
	if err != nil || res.Missing != 4 || res.Extra != 3 {
		t.Fatalf("reconcile: %+v, %v", res, err)
	}
	if !check(member, authz.ProjectEdit, project) {
		t.Fatal("deleted member and default relationships were not restored")
	}
	if !check(owner, authz.ProjectDelete, project) {
		t.Fatal("deleted project#org relationship was not restored")
	}
	if !check(grantee, authz.ProjectManageAccess, project) {
		t.Fatal("deleted project role was not restored")
	}
	if check(stranger, authz.OrgManage, authz.Organization(o)) {
		t.Fatal("stray admin relationship was not removed")
	}
	if check(sharee, authz.ProjectView, project) {
		t.Fatal("project role without a project_members row was not removed")
	}
	if got := counter(t, reg, "apilens_authz_drift_total", "missing"); got != 4 {
		t.Fatalf("drift missing = %v, want 4", got)
	}
	if got := counter(t, reg, "apilens_authz_drift_total", "extra"); got != 3 {
		t.Fatalf("drift extra = %v, want 3", got)
	}

	// The default relations follow projects.default_access: `viewer` swaps
	// default_editor@member for default_viewer@member, `none` holds none.
	setAccess := func(access string) {
		t.Helper()
		if _, err := env.pool.Exec(ctx, `UPDATE projects SET default_access = $2 WHERE id = $1`, proj, access); err != nil {
			t.Fatal(err)
		}
	}
	setAccess("viewer")
	if res, err = rec.Reconcile(ctx, false); err != nil || res.Missing != 1 || res.Extra != 1 {
		t.Fatalf("default access viewer: %+v, %v", res, err)
	}
	if check(member, authz.ProjectEdit, project) || !check(member, authz.ProjectView, project) {
		t.Fatal("with default access viewer an org member must view, not edit")
	}
	setAccess("none")
	if res, err = rec.Reconcile(ctx, false); err != nil || res.Missing != 0 || res.Extra != 2 {
		t.Fatalf("default access none: %+v, %v", res, err)
	}
	if check(member, authz.ProjectView, project) {
		t.Fatal("with default access none an org member must not view")
	}
	if !check(grantee, authz.ProjectManageAccess, project) {
		t.Fatal("a direct grant must survive default access none")
	}

	// A soft-deleted organization implies no relationships: three org
	// roles, project#org and the direct grant go.
	if _, err := env.pool.Exec(ctx, `UPDATE organizations SET deleted_at = now() WHERE id = $1`, org); err != nil {
		t.Fatal(err)
	}
	res, err = rec.Reconcile(ctx, false)
	if err != nil || res.Missing != 0 || res.Extra != 5 {
		t.Fatalf("after org deletion: %+v, %v", res, err)
	}
	if check(owner, authz.OrgView, authz.Organization(o)) {
		t.Fatal("owner still sees the deleted org")
	}

	// Once repaired, a second run finds nothing.
	if res, err = rec.Reconcile(ctx, false); err != nil || res.Missing != 0 || res.Extra != 0 {
		t.Fatalf("second run: %+v, %v", res, err)
	}
}
