//go:build integration

package orgs

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestLeaveDropsProjectGrantsIntegration checks that leaving an organization
// removes the person's direct grants on its projects (and only its projects)
// and emits one project_member.deleted per grant in the same transaction.
func TestLeaveDropsProjectGrantsIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	svc := New(pool, audit.New(pool))
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	owner, dev := uuid.New(), uuid.New()
	exec(`INSERT INTO users (id, email) VALUES ($1, 'leave-owner@example.com'), ($2, 'leave-dev@example.com')`, owner, dev)
	org, err := svc.Create(ctx, owner, "Acme", "acme-leave")
	if err != nil {
		t.Fatal(err)
	}
	other, err := svc.Create(ctx, owner, "Globex", "globex-leave")
	if err != nil {
		t.Fatal(err)
	}
	shop, blog, foreign := uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $4, 'leave-shop', 'Shop'), ($2, $4, 'leave-blog', 'Blog'), ($3, $5, 'leave-foreign', 'Foreign')`,
		shop, blog, foreign, org.ID, other.ID)
	exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $3, 'member'), ($2, $3, 'member')`, org.ID, other.ID, dev)
	exec(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $4, 'admin'), ($2, $4, 'viewer'), ($3, $4, 'editor')`, shop, blog, foreign, dev)

	if err := svc.Leave(ctx, dev, "acme-leave"); err != nil {
		t.Fatal(err)
	}

	var grants []uuid.UUID
	rows, err := pool.Query(ctx, `SELECT project_id FROM project_members WHERE user_id = $1`, dev)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		grants = append(grants, id)
	}
	rows.Close()
	if len(grants) != 1 || grants[0] != foreign {
		t.Fatalf("grants after leaving = %v, want only the other org's project %s", grants, foreign)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE topic = 'project_member.deleted' AND payload->>'user_id' = $1
		AND payload->>'org_id' = $2 AND aggregate_id IN ($3, $4)`, dev.String(), org.ID.String(), shop.String(), blog.String()).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("project_member.deleted rows = %d, want 2", n)
	}
}
