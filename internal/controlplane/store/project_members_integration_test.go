//go:build integration

package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/testutil"
)

func TestProjectMemberQueries(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	newUser := func(email string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		exec(`INSERT INTO users (id, email) VALUES ($1, $2)`, id, email)
		return id
	}
	admin, dev, viewer := newUser("admin@example.com"), newUser("dev@example.com"), newUser("viewer@example.com")
	org, other := uuid.New(), uuid.New()
	exec(`INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme'), ($2, 'globex', 'Globex')`, org, other)
	shop, blog, foreign := uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $4, 'shop', 'Shop'), ($2, $4, 'blog', 'Blog'), ($3, $5, 'globex-api', 'Globex API')`,
		shop, blog, foreign, org, other)

	// Existing and new projects read org_role.
	if access, err := q.GetProjectDefaultAccess(ctx, shop); err != nil || access != "org_role" {
		t.Fatalf("default access = %q, %v; want org_role", access, err)
	}
	if access, err := q.SetProjectDefaultAccess(ctx, db.SetProjectDefaultAccessParams{ID: shop, DefaultAccess: "none"}); err != nil || access != "none" {
		t.Fatalf("set default access = %q, %v", access, err)
	}
	if _, err := q.SetProjectDefaultAccess(ctx, db.SetProjectDefaultAccessParams{ID: shop, DefaultAccess: "owner"}); err == nil {
		t.Fatal("an unknown default access should violate the check")
	}

	// Upsert grants, then changes the role while keeping added_by.
	m, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: shop, UserID: dev, Role: "viewer", AddedBy: &admin})
	if err != nil || m.Role != "viewer" || m.AddedBy == nil || *m.AddedBy != admin {
		t.Fatalf("grant = %+v, %v", m, err)
	}
	m2, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: shop, UserID: dev, Role: "editor"})
	if err != nil || m2.Role != "editor" || m2.AddedBy == nil || *m2.AddedBy != admin || !m2.CreatedAt.Equal(m.CreatedAt) || m2.UpdatedAt.Before(m.UpdatedAt) {
		t.Fatalf("role change = %+v, %v", m2, err)
	}
	if _, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: shop, UserID: dev, Role: "owner"}); err == nil {
		t.Fatal("an unknown project role should violate the check")
	}
	for _, g := range []db.UpsertProjectMemberParams{
		{ProjectID: shop, UserID: viewer, Role: "viewer", AddedBy: &admin},
		{ProjectID: blog, UserID: dev, Role: "admin", AddedBy: &admin},
		{ProjectID: foreign, UserID: dev, Role: "viewer"},
	} {
		if _, err := q.UpsertProjectMember(ctx, g); err != nil {
			t.Fatal(err)
		}
	}

	// List by project (joined with users) and by user.
	members, err := q.ListProjectMembers(ctx, shop)
	if err != nil || len(members) != 2 || members[0].Email != "dev@example.com" || members[0].Role != "editor" || members[1].Email != "viewer@example.com" {
		t.Fatalf("project members = %+v, %v", members, err)
	}
	grants, err := q.ListUserProjectMembers(ctx, dev)
	if err != nil || len(grants) != 3 || grants[0].ProjectSlug != "blog" || grants[0].Role != "admin" {
		t.Fatalf("user grants = %+v, %v", grants, err)
	}

	// Delete one grant.
	if n, err := q.DeleteProjectMember(ctx, db.DeleteProjectMemberParams{ProjectID: shop, UserID: viewer}); err != nil || n != 1 {
		t.Fatalf("delete = %d, %v", n, err)
	}
	if _, err := q.GetProjectMember(ctx, db.GetProjectMemberParams{ProjectID: shop, UserID: viewer}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("deleted grant = %v; want ErrNoRows", err)
	}

	// Leaving an org drops the grants in that org only.
	removed, err := q.DeleteUserProjectMembersInOrg(ctx, db.DeleteUserProjectMembersInOrgParams{OrgID: org, UserID: dev})
	if err != nil || len(removed) != 2 {
		t.Fatalf("org grants removed = %v, %v; want shop and blog", removed, err)
	}
	if grants, err := q.ListUserProjectMembers(ctx, dev); err != nil || len(grants) != 1 || grants[0].ProjectID != foreign {
		t.Fatalf("grants after leaving acme = %+v, %v", grants, err)
	}

	// Hard-deleting a project cascades to its grants.
	if _, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: blog, UserID: viewer, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	exec(`DELETE FROM projects WHERE id = $1`, blog)
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_members WHERE project_id = $1`, blog).Scan(&left); err != nil || left != 0 {
		t.Fatalf("grants of a deleted project = %d, %v; want 0", left, err)
	}
	// Purging the granting user keeps the grant without its author.
	if _, err := q.UpsertProjectMember(ctx, db.UpsertProjectMemberParams{ProjectID: shop, UserID: viewer, Role: "viewer", AddedBy: &admin}); err != nil {
		t.Fatal(err)
	}
	exec(`DELETE FROM users WHERE id = $1`, admin)
	if m, err := q.GetProjectMember(ctx, db.GetProjectMemberParams{ProjectID: shop, UserID: viewer}); err != nil || m.AddedBy != nil {
		t.Fatalf("grant after purging its author = %+v, %v; want added_by NULL", m, err)
	}
}

// The migration rolls back and re-applies on a database with existing
// projects, which read org_role afterwards.
func TestProjectMembersMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	sqlDB := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = sqlDB.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}
	var version int64
	for _, s := range provider.ListSources() {
		if strings.HasSuffix(s.Path, "_project_members.sql") {
			version = s.Version
		}
	}
	if version == 0 {
		t.Fatal("project_members migration not found")
	}

	if _, err := provider.DownTo(ctx, version-1); err != nil {
		t.Fatalf("roll back: %v", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('project_members') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("project_members after rollback = %v, %v; want gone", exists, err)
	}
	org, project := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'shop', 'Shop')`, project, org); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	var access string
	if err := pool.QueryRow(ctx, `SELECT default_access FROM projects WHERE id = $1`, project).Scan(&access); err != nil || access != "org_role" {
		t.Fatalf("existing project default access = %q, %v; want org_role", access, err)
	}
}
