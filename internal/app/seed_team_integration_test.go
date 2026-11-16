//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/testutil"
)

// TestSeedWithTeam covers `apilens seed -with-team` (#829): demo members in
// every org role, a restricted project with direct grants, environments
// with settings, API keys in every state and their audit events; a second
// run changes none of it.
func TestSeedWithTeam(t *testing.T) {
	ctx := context.Background()
	pgcfg := testutil.Postgres(t)
	env := []string{
		"APILENS_POSTGRES__URL=" + pgcfg.URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_IDENTITY__PUBLIC_UI_URL=https://ui.example.com/",
		"APILENS_LOG__FORMAT=text",
	}
	run := func(args ...string) []byte {
		t.Helper()
		var stdout, stderr bytes.Buffer
		if code := Main(args, &stdout, &stderr, env); code != 0 {
			t.Fatalf("%v: exit %d: %s", args, code, stderr.String())
		}
		return stdout.Bytes()
	}
	run("migrate", "-only=postgres")
	pool, err := pgxpool.New(ctx, pgcfg.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	count := func(query string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// snapshot is everything -with-team writes. The api_keys count leaves
	// out the base seed's keys, which every run issues anew.
	snapshot := func() map[string]any {
		t.Helper()
		var envs, grants, keys string
		if err := pool.QueryRow(ctx, `SELECT string_agg(p.slug || '/' || e.name || ':' || e.is_production || ':' || coalesce(e.color, '') || ':' ||
				(e.hidden_at IS NOT NULL) || ':' || e.position || ':' || e.created_at, ',' ORDER BY p.slug, e.name)
			FROM environments e JOIN projects p ON p.id = e.project_id`).Scan(&envs); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT string_agg(p.slug || ':' || u.email || ':' || pm.role || ':' || pm.updated_at, ',' ORDER BY p.slug, u.email)
			FROM project_members pm JOIN projects p ON p.id = pm.project_id JOIN users u ON u.id = pm.user_id`).Scan(&grants); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT string_agg(k.name || ':' || k.prefix || ':' || coalesce(k.expires_at::text, '') || ':' ||
				(k.revoked_at IS NOT NULL) || ':' || (k.rotated_to IS NOT NULL), ',' ORDER BY k.created_at, k.id)
			FROM api_keys k WHERE k.name NOT IN ('seed', 'seed-read')`).Scan(&keys); err != nil {
			t.Fatal(err)
		}
		return map[string]any{
			"users":       count(`SELECT count(*) FROM users`),
			"memberships": count(`SELECT count(*) FROM memberships`),
			"projects":    count(`SELECT count(*) FROM projects`),
			"default":     count(`SELECT count(*) FROM projects WHERE default_access = 'none'`),
			"user_names":  count(`SELECT count(*) FROM users WHERE name <> ''`),
			"envs":        envs,
			"grants":      grants,
			"keys":        keys,
			"outbox":      count(`SELECT count(*) FROM outbox`),
			"audit":       count(`SELECT count(*) FROM audit_events WHERE event <> 'login.requested'`),
		}
	}

	var out struct {
		Team struct {
			Members           []struct{ Email, Role string } `json:"members"`
			RestrictedProject string                         `json:"restricted_project"`
			APIKeys           []string                       `json:"api_keys"`
		} `json:"team"`
	}
	if err := json.Unmarshal(run("seed", "-with-team"), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Team.Members) != 4 || out.Team.RestrictedProject != "payments" || len(out.Team.APIKeys) != 4 {
		t.Fatalf("seed -with-team = %+v", out.Team)
	}
	for role, want := range map[string]int{"owner": 1, "admin": 1, "member": 2, "viewer": 1} {
		if got := count(`SELECT count(*) FROM memberships WHERE role = '` + role + `'`); got != want {
			t.Errorf("%s memberships = %d, want %d", role, got, want)
		}
	}
	if count(`SELECT count(*) FROM projects WHERE slug = 'payments' AND default_access = 'none'`) != 1 {
		t.Error("payments is not restricted")
	}
	if count(`SELECT count(*) FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.slug = 'payments'`) != 2 {
		t.Error("payments does not have two direct grants")
	}
	if count(`SELECT count(*) FROM environments e JOIN projects p ON p.id = e.project_id
		WHERE p.slug = 'dev' AND e.color IS NOT NULL`) != 4 ||
		count(`SELECT count(*) FROM environments e JOIN projects p ON p.id = e.project_id
		WHERE p.slug = 'dev' AND e.is_production AND e.name = 'production'`) != 1 ||
		count(`SELECT count(*) FROM environments WHERE hidden_at IS NOT NULL`) != 1 {
		t.Error("environment settings not seeded")
	}
	states := map[string]string{
		"active":   `revoked_at IS NULL AND rotated_to IS NULL AND expires_at IS NULL AND name <> 'seed' AND name <> 'seed-read'`,
		"expiring": `revoked_at IS NULL AND rotated_to IS NULL AND expires_at < now() + interval '7 days'`,
		"rotating": `revoked_at IS NULL AND rotated_to IS NOT NULL AND expires_at > now()`,
		"revoked":  `revoked_at IS NOT NULL`,
	}
	for state, where := range states {
		if count(`SELECT count(*) FROM api_keys WHERE `+where) == 0 {
			t.Errorf("no %s key", state)
		}
	}
	for _, event := range []string{"member.added", "project.created", "project.access_changed", "project_member.added",
		"environment.added", "environment.updated", "api_key.created", "api_key.rotated", "api_key.revoked"} {
		if count(`SELECT count(*) FROM audit_events WHERE event = '`+event+`'`) == 0 {
			t.Errorf("no %s audit event", event)
		}
	}

	first := snapshot()
	run("seed", "-with-team")
	second := snapshot()
	for k, v := range first {
		if second[k] != v {
			t.Errorf("second run changed %s: %v -> %v", k, v, second[k])
		}
	}
}
