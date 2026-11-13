//go:build integration

package db

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/testutil"
)

func seedScopedAudit(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, project, actor uuid.UUID, base time.Time) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, 'ada@example.com', 'Ada')`, actor); err != nil {
		t.Fatal(err)
	}
	// Six events at one-minute steps: three org-wide, three in the project.
	for i, ev := range []string{"org.updated", "member.added", "member.removed", "api_key.created", "api_key.revoked", "capture_policy.updated"} {
		var proj *uuid.UUID
		if i >= 3 {
			proj = &project
		}
		var who *uuid.UUID
		if i%2 == 0 {
			who = &actor
		}
		if _, err := pool.Exec(ctx, `INSERT INTO audit_events (actor_user_id, event, org_id, project_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
			who, ev, org, proj, base.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	// Noise across many other orgs and projects, so reading the whole table
	// costs more than reading one scope through its index.
	if _, err := pool.Exec(ctx, `INSERT INTO audit_events (event, org_id, project_id, created_at)
		SELECT 'org.updated', gen_random_uuid(), gen_random_uuid(), $1::timestamptz + g * interval '1 second'
		FROM generate_series(1, 20000) g`, base); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ANALYZE audit_events`); err != nil {
		t.Fatal(err)
	}
}

func events(rows []AuditEvent) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Event
	}
	return out
}

func TestListAuditEventsForOrgAndProject(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := New(pool)
	org, project, actor := uuid.New(), uuid.New(), uuid.New()
	base := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	seedScopedAudit(t, ctx, pool, org, project, actor, base)

	all, err := q.ListAuditEventsForOrg(ctx, ListAuditEventsForOrgParams{OrgID: org, PageSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(events(all), ","), "capture_policy.updated,api_key.revoked,api_key.created,member.removed,member.added,org.updated"; got != want {
		t.Errorf("org events = %s, want %s", got, want)
	}

	// Keyset pagination: two pages of three cover the six events.
	page1, err := q.ListAuditEventsForOrg(ctx, ListAuditEventsForOrgParams{OrgID: org, PageSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	last := page1[len(page1)-1]
	page2, err := q.ListAuditEventsForOrg(ctx, ListAuditEventsForOrgParams{OrgID: org, PageSize: 3, BeforeCreatedAt: &last.CreatedAt, BeforeID: &last.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(append(events(page1), events(page2)...), ","), strings.Join(events(all), ","); got != want {
		t.Errorf("paged = %s, want %s", got, want)
	}

	prefix := "member."
	from, to := base.Add(time.Minute), base.Add(5*time.Minute)
	filtered, err := q.ListAuditEventsForOrg(ctx, ListAuditEventsForOrgParams{OrgID: org, PageSize: 10, EventPrefix: &prefix})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(events(filtered), ","); got != "member.removed,member.added" {
		t.Errorf("prefix filter = %s", got)
	}
	byActor, err := q.ListAuditEventsForOrg(ctx, ListAuditEventsForOrgParams{OrgID: org, PageSize: 10, ActorUserID: &actor, FromTime: &from, ToTime: &to})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(events(byActor), ","); got != "api_key.revoked,member.removed" {
		t.Errorf("actor + time filter = %s", got)
	}

	proj, err := q.ListAuditEventsForProject(ctx, ListAuditEventsForProjectParams{ProjectID: project, PageSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(events(proj), ","); got != "capture_policy.updated,api_key.revoked,api_key.created" {
		t.Errorf("project events = %s", got)
	}
	projPrefix := "api_key."
	proj, err = q.ListAuditEventsForProject(ctx, ListAuditEventsForProjectParams{ProjectID: project, PageSize: 1, EventPrefix: &projPrefix})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(events(proj), ","); got != "api_key.revoked" {
		t.Errorf("project prefix page = %s", got)
	}
}

// TestAuditListQueriesUseScopeIndexes checks the plans of the generated
// queries: each reads its scope index, never the whole table.
func TestAuditListQueriesUseScopeIndexes(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	org, project, actor := uuid.New(), uuid.New(), uuid.New()
	base := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	seedScopedAudit(t, ctx, pool, org, project, actor, base)

	cursor, prefix := base.Add(3*time.Minute), "api_key."
	for _, tc := range []struct {
		name, sql, index string
		args             []any
	}{
		{"org first page", listAuditEventsForOrg, "audit_events_org_created", []any{org, nil, nil, nil, nil, nil, nil, 50}},
		{"org filtered page", listAuditEventsForOrg, "audit_events_org_created", []any{org, actor, prefix, base, base.Add(time.Hour), cursor, int64(4), 50}},
		{"project first page", listAuditEventsForProject, "audit_events_project_created", []any{project, nil, nil, nil, nil, nil, nil, 50}},
		{"project filtered page", listAuditEventsForProject, "audit_events_project_created", []any{project, actor, prefix, base, base.Add(time.Hour), cursor, int64(4), 50}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, err := pool.Query(ctx, "EXPLAIN "+tc.sql, tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			var plan []string
			for rows.Next() {
				var line string
				if err := rows.Scan(&line); err != nil {
					t.Fatal(err)
				}
				plan = append(plan, line)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			text := strings.Join(plan, "\n")
			t.Logf("plan:\n%s", text)
			if !strings.Contains(text, tc.index) || strings.Contains(text, "Seq Scan") {
				t.Errorf("plan does not use %s:\n%s", tc.index, text)
			}
		})
	}
}
