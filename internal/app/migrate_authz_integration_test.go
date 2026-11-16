//go:build integration

package app

import (
	"bytes"
	"context"
	"testing"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	authzed "github.com/authzed/authzed-go/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/testutil"
)

// previousSchema is authz/schema.zed before the default-access relations
// (#765): every org member edits and every org viewer views every project
// through the organization.
const previousSchema = `definition user {}

definition organization {
	relation owner: user
	relation admin: user
	relation member: user
	relation viewer: user
	permission manage = owner + admin
	permission manage_members = manage
	permission invite = manage
	permission manage_billing = owner
	permission create_project = member + manage
	permission view = viewer + create_project
}

definition project {
	relation org: organization
	relation admin: user
	relation editor: user
	relation viewer: user
	permission delete = admin + org->manage
	permission manage_keys = admin + editor + org->create_project
	permission manage_capture = admin + org->manage
	permission manage_alerts = admin + org->manage
	permission edit = admin + editor + org->create_project
	permission view = viewer + edit + org->view
}
`

// lastMigrationBeforeProjectMembers is the Postgres version the previous
// release ran (00032 adds project_members and projects.default_access).
const lastMigrationBeforeProjectMembers = 31

// TestMigrateUpgradeKeepsAccess upgrades a database and a SpiceDB at the
// previous version with `apilens migrate` and checks every org member keeps
// exactly the access they had, also while the bridge schema is in place.
func TestMigrateUpgradeKeepsAccess(t *testing.T) {
	ctx := context.Background()
	pgcfg := testutil.Postgres(t)
	sdbcfg := testutil.SpiceDB(t)
	logger := testutil.Logger(t)

	// Postgres at the previous version.
	pool, err := pg.Connect(ctx, pgcfg, "apilens-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	sqlDB := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = sqlDB.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.UpTo(ctx, lastMigrationBeforeProjectMembers); err != nil {
		t.Fatal(err)
	}

	// Two orgs: acme with one user per role and two projects, and other
	// with its own owner and project.
	acme, other := uuid.New(), uuid.New()
	owner, admin, member, viewer, outsider := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	web, docs, theirs := uuid.New(), uuid.New(), uuid.New()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com'), ($2, 'admin@example.com'), ($3, 'member@example.com'), ($4, 'viewer@example.com'), ($5, 'outsider@example.com')`,
			[]any{owner, admin, member, viewer, outsider}},
		{`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme'), ($2, 'other', 'Other')`, []any{acme, other}},
		{`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($6, $7, 'owner')`,
			[]any{acme, owner, admin, member, viewer, other, outsider}},
		{`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $3, 'web', 'Web'), ($2, $3, 'docs', 'Docs'), ($4, $5, 'theirs', 'Theirs')`,
			[]any{web, docs, acme, theirs, other}},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}

	// SpiceDB at the previous version, holding what the previous relay
	// wrote: org roles and project#org only.
	sdb, err := spicedb.Connect(sdbcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, previousSchema, logger); err != nil {
		t.Fatal(err)
	}
	ref := func(typ string, id uuid.UUID) *v1.ObjectReference {
		return &v1.ObjectReference{ObjectType: typ, ObjectId: id.String()}
	}
	touch := func(res *v1.ObjectReference, relation string, sub *v1.ObjectReference) *v1.RelationshipUpdate {
		return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: &v1.Relationship{
			Resource: res, Relation: relation, Subject: &v1.SubjectReference{Object: sub},
		}}
	}
	if _, err := sdb.WriteRelationships(ctx, &v1.WriteRelationshipsRequest{Updates: []*v1.RelationshipUpdate{
		touch(ref("organization", acme), "owner", ref("user", owner)),
		touch(ref("organization", acme), "admin", ref("user", admin)),
		touch(ref("organization", acme), "member", ref("user", member)),
		touch(ref("organization", acme), "viewer", ref("user", viewer)),
		touch(ref("organization", other), "owner", ref("user", outsider)),
		touch(ref("project", web), "org", ref("organization", acme)),
		touch(ref("project", docs), "org", ref("organization", acme)),
		touch(ref("project", theirs), "org", ref("organization", other)),
	}}); err != nil {
		t.Fatal(err)
	}

	before := accessMatrix(t, sdb, []uuid.UUID{owner, admin, member, viewer, outsider}, []uuid.UUID{web, docs, theirs})
	if !before[key(member, web, "edit")] || !before[key(viewer, docs, "view")] || before[key(viewer, web, "edit")] {
		t.Fatalf("previous schema grants unexpected access: %v", before)
	}

	// The bridge schema alone, before any backfill, grants the same.
	bridge, ok := authz.BridgeSchema()
	if !ok {
		t.Fatal("BridgeSchema does not match schema.zed")
	}
	if err := spicedb.ApplySchema(ctx, sdb, bridge, logger); err != nil {
		t.Fatalf("write bridge schema: %v", err)
	}
	assertSameAccess(t, "bridge schema before the backfill", before,
		accessMatrix(t, sdb, []uuid.UUID{owner, admin, member, viewer, outsider}, []uuid.UUID{web, docs, theirs}))
	if err := spicedb.ApplySchema(ctx, sdb, previousSchema, logger); err != nil {
		t.Fatalf("restore previous schema: %v", err)
	}

	env := []string{
		"APILENS_POSTGRES__URL=" + pgcfg.URL,
		"APILENS_AUTHZ__ENDPOINT=" + sdbcfg.Endpoint,
		"APILENS_AUTHZ__PRESHARED_KEY=" + sdbcfg.PresharedKey,
		"APILENS_AUTHZ__INSECURE=true",
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_LOG__FORMAT=text",
	}
	for range 2 { // the second run is a no-op
		var stderr bytes.Buffer
		if code := Main([]string{"migrate", "-only=postgres,authz"}, &bytes.Buffer{}, &stderr, env); code != 0 {
			t.Fatalf("migrate: exit %d: %s", code, stderr.String())
		}
		assertSameAccess(t, "after migrate", before,
			accessMatrix(t, sdb, []uuid.UUID{owner, admin, member, viewer, outsider}, []uuid.UUID{web, docs, theirs}))
		current, err := spicedb.ReadSchema(ctx, sdb, logger)
		if err != nil {
			t.Fatal(err)
		}
		if authz.InheritsOrgAccess(current) {
			t.Fatalf("migrate left a schema in which access flows down from the org:\n%s", current)
		}
	}

	// Access now comes from the backfilled default relations: restricting
	// a project takes it away from org members and viewers.
	if _, err := pool.Exec(ctx, `UPDATE projects SET default_access = 'none' WHERE id = $1`, docs); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := Main([]string{"authz", "reconcile"}, &stdout, &stderr, env); code != 0 {
		t.Fatalf("reconcile: exit %d: %s", code, stderr.String())
	}
	after := accessMatrix(t, sdb, []uuid.UUID{member, viewer, owner}, []uuid.UUID{docs})
	if after[key(member, docs, "view")] || after[key(viewer, docs, "view")] || !after[key(owner, docs, "delete")] {
		t.Fatalf("restricted project access: %v", after)
	}
}

func key(user, project uuid.UUID, perm string) string {
	return user.String() + " " + perm + " " + project.String()
}

// accessMatrix checks every permission the previous schema had for every
// user on every project, fully consistent.
func accessMatrix(t *testing.T, sdb *authzed.Client, users, projects []uuid.UUID) map[string]bool {
	t.Helper()
	got := map[string]bool{}
	for _, u := range users {
		for _, p := range projects {
			for _, perm := range []string{"delete", "manage_keys", "manage_capture", "manage_alerts", "edit", "view"} {
				resp, err := sdb.CheckPermission(context.Background(), &v1.CheckPermissionRequest{
					Consistency: &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}},
					Resource:    &v1.ObjectReference{ObjectType: "project", ObjectId: p.String()},
					Permission:  perm,
					Subject:     &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: "user", ObjectId: u.String()}},
				})
				if err != nil {
					t.Fatal(err)
				}
				got[key(u, p, perm)] = resp.GetPermissionship() == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION
			}
		}
	}
	return got
}

func assertSameAccess(t *testing.T, when string, want, got map[string]bool) {
	t.Helper()
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s: %s = %v, want %v", when, k, got[k], w)
		}
	}
}
