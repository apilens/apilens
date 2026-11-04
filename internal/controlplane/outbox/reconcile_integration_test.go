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

func TestReconcilerRepairsDrift(t *testing.T) {
	env := newRelayEnv(t)
	ctx := context.Background()
	reg := prometheus.NewRegistry()
	rec := outbox.NewReconciler(env.pool, env.sdb, env.authz, outbox.ReconcileOptions{}, tu.Logger(t), reg)

	// Postgres: an org with an owner and a member, and a project in it,
	// written with their outbox rows and relayed to SpiceDB.
	org, owner, member, proj := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com'), ($2, 'member@example.com')`, []any{owner, member}},
		{`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, []any{org}},
		{`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, []any{org, owner, member}},
		{`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'checkout', 'Checkout')`, []any{proj, org}},
	} {
		if _, err := env.pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	emit(t, env.pool, outbox.OrgCreated, org, outbox.OrgCreatedPayload{OrgID: org, OwnerUserID: owner})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: member, Role: "member"})
	emit(t, env.pool, outbox.ProjectCreated, proj, outbox.ProjectCreatedPayload{ProjectID: proj, OrgID: org})
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

	// Someone deletes relationships by hand: the member's role and the
	// project's org.
	writeRels(t, env, o, v1.RelationshipUpdate_OPERATION_DELETE,
		rel(authz.TypeOrganization, o, "member", authz.TypeUser, member.String()),
		rel(authz.TypeProject, p, "org", authz.TypeOrganization, o))
	// ...and adds some Postgres has no source for, plus a project-level
	// role the reconciler does not own.
	stranger, sharee, ghost := uuid.New(), uuid.New(), uuid.New()
	writeRels(t, env, o, v1.RelationshipUpdate_OPERATION_TOUCH,
		rel(authz.TypeOrganization, o, "admin", authz.TypeUser, stranger.String()),
		rel(authz.TypeProject, ghost.String(), "org", authz.TypeOrganization, o),
		rel(authz.TypeProject, p, "viewer", authz.TypeUser, sharee.String()))
	if check(member, authz.ProjectEdit, project) {
		t.Fatal("member can still edit after the relationship was deleted")
	}
	if !check(stranger, authz.OrgManage, authz.Organization(o)) {
		t.Fatal("stranger cannot manage after the relationship was added")
	}

	// A dry run reports the drift and repairs nothing.
	res, err = rec.Reconcile(ctx, true)
	if err != nil || res.Missing != 2 || res.Extra != 2 || !res.DryRun {
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
	if err != nil || res.Missing != 2 || res.Extra != 2 {
		t.Fatalf("reconcile: %+v, %v", res, err)
	}
	if !check(member, authz.ProjectEdit, project) {
		t.Fatal("deleted member relationship was not restored")
	}
	if !check(owner, authz.ProjectDelete, project) {
		t.Fatal("deleted project#org relationship was not restored")
	}
	if check(stranger, authz.OrgManage, authz.Organization(o)) {
		t.Fatal("stray admin relationship was not removed")
	}
	if !check(sharee, authz.ProjectView, project) {
		t.Fatal("project-level role was removed; the reconciler does not own it")
	}
	if got := counter(t, reg, "apilens_authz_drift_total", "missing"); got != 2 {
		t.Fatalf("drift missing = %v, want 2", got)
	}
	if got := counter(t, reg, "apilens_authz_drift_total", "extra"); got != 2 {
		t.Fatalf("drift extra = %v, want 2", got)
	}

	// A soft-deleted organization implies no relationships.
	if _, err := env.pool.Exec(ctx, `UPDATE organizations SET deleted_at = now() WHERE id = $1`, org); err != nil {
		t.Fatal(err)
	}
	res, err = rec.Reconcile(ctx, false)
	if err != nil || res.Missing != 0 || res.Extra != 3 {
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
