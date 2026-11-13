//go:build integration

package purge_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	authzed "github.com/authzed/authzed-go/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/valkey-io/valkey-go"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/purge"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/testutil"
)

// timeColumn is the column each ClickHouse table's TTL reads; rows get now()
// there so a merge does not expire them before the test looks.
var timeColumn = map[string]string{
	"api_requests":    "timestamp",
	"api_logs":        "timestamp",
	"api_spans":       "timestamp",
	"api_deploys":     "deployed_at",
	"api_requests_1m": "bucket",
	"api_requests_1h": "bucket",
	"api_consumers":   "",
}

type fixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	ch     driver.Conn
	vk     valkey.Client
	sdb    *authzed.Client
	relay  *outbox.Relay
	files  *files
	purger *purge.Purger
	// mine is purged, theirs must survive untouched.
	mine, theirs bootstrap.Result
}

// files is an export store that remembers what was removed and can fail.
type files struct {
	removed []string
	fail    error
}

func (f *files) Remove(_ context.Context, key string) error {
	if f.fail != nil {
		return f.fail
	}
	f.removed = append(f.removed, key)
	return nil
}

const grace = 7 * 24 * time.Hour

func setup(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)

	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)

	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}
	checker := authz.New(sdb, nil, authz.Options{}, logger, nil)

	f := &fixture{ctx: ctx, pool: pool, ch: conn, vk: vk, sdb: sdb, files: &files{}}
	f.relay = outbox.NewRelay(pool, sdb, checker, outbox.RelayOptions{}, logger, nil)
	f.purger = purge.New(pool, conn, purge.Options{Valkey: vk, Files: f.files, Audit: audit.New(pool), OrgGrace: grace}, logger)

	if f.mine, err = bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"}); err != nil {
		t.Fatal(err)
	}
	if f.theirs, err = bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []bootstrap.Result{f.mine, f.theirs} {
		f.fill(t, p)
	}
	// The relationships of both projects, as the reconciler writes them from
	// Postgres.
	if _, err := outbox.NewReconciler(pool, sdb, checker, outbox.ReconcileOptions{}, logger, nil).Reconcile(ctx, false); err != nil {
		t.Fatal(err)
	}
	for _, p := range []bootstrap.Result{f.mine, f.theirs} {
		if n := f.relationships(t, p.ProjectID); n == 0 {
			t.Fatalf("project %s has no SpiceDB relationships before the purge", p.ProjectSlug)
		}
	}
	return f
}

// fill gives the project rows in Postgres, ClickHouse and Valkey beyond
// what the seed writes.
func (f *fixture) fill(t *testing.T, p bootstrap.Result) {
	t.Helper()
	ctx := f.ctx
	user := uuid.New()
	exec(t, f.pool, `INSERT INTO users (id, email, name) VALUES ($1, $2, 'Ada')`, user, p.ProjectSlug+"@example.com")
	exec(t, f.pool, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, p.OrgID, user)
	exec(t, f.pool, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, p.ProjectID, user)
	exec(t, f.pool, `INSERT INTO saved_views (id, project_id, name, surface) VALUES ($1, $2, 'Slow', 'explore')`, uuid.New(), p.ProjectID)
	exec(t, f.pool, `INSERT INTO notification_channels (id, project_id, type, name, config_enc) VALUES ($1, $2, 'email', 'Ops', '\x01')`, uuid.New(), p.ProjectID)
	rule := uuid.New()
	exec(t, f.pool, `INSERT INTO alert_rules (id, project_id, app_id, environment, name, metric, condition, threshold, window_s, every_s)
		VALUES ($1, $2, $3, 'production', 'Errors', 'errors', 'gt', 1, 300, 60)`, rule, p.ProjectID, p.AppID)
	exec(t, f.pool, `INSERT INTO request_exports (id, project_id, range_from, range_to, status, row_limit, file_key, signing_key)
		VALUES ($1, $2, now() - interval '1 hour', now(), 'completed', 10, $3, $4)`, uuid.New(), p.ProjectID, "export-"+p.ProjectSlug, make([]byte, 32))

	for _, table := range purge.ClickHouseTables {
		cols, vals := "project_id", "?"
		if c := timeColumn[table]; c != "" {
			cols, vals = cols+", "+c, vals+", now()"
		}
		if err := f.ch.Exec(ctx, fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, cols, vals), p.ProjectID); err != nil {
			t.Fatalf("insert into %s: %v", table, err)
		}
	}

	day := time.Now().UTC().Format(time.DateOnly)
	for _, key := range []string{
		"apilens:ingest:usage:" + p.ProjectID.String() + ":" + day,
		"apilens:ingest:stats:" + p.AppID.String() + ":" + day,
		"apilens:app:last_seen:" + p.AppID.String() + ":production",
	} {
		if err := f.vk.Do(ctx, f.vk.B().Set().Key(key).Value("1").Build()).Error(); err != nil {
			t.Fatal(err)
		}
	}
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", strings.Fields(sql)[2], err)
	}
}

// deleteProject schedules p's purge in the past, as a delete whose grace
// period has run out leaves it (without the outbox row, so only the purge
// can drop the relationships).
func (f *fixture) deleteProject(t *testing.T, p bootstrap.Result) {
	t.Helper()
	exec(t, f.pool, `UPDATE projects SET deleted_at = now() - interval '8 days', purge_after = now() - interval '1 day' WHERE id = $1`, p.ProjectID)
}

// relationships counts p's SpiceDB relationships.
func (f *fixture) relationships(t *testing.T, project uuid.UUID) int {
	t.Helper()
	stream, err := f.sdb.ReadRelationships(f.ctx, &v1.ReadRelationshipsRequest{
		Consistency:        &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}},
		RelationshipFilter: &v1.RelationshipFilter{ResourceType: authz.TypeProject, OptionalResourceId: project.String()},
	})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for {
		if _, err := stream.Recv(); errors.Is(err, io.EOF) {
			return n
		} else if err != nil {
			t.Fatal(err)
		}
		n++
	}
}

// keptTables are the Postgres tables that keep the project id on purpose.
var keptTables = map[string]string{
	"projects":             "the tombstone the audit log and the slug reservation point at",
	"project_purges":       "the purge's own record",
	"project_slug_history": "the 30-day slug reservation",
	"audit_events":         "the audit log outlives the project (D7)",
}

// leftovers lists, for every Postgres table with a project_id, app_id or
// key_id column, the rows that still name the project, its apps or its
// keys. Tables are read from information_schema, so a new table cannot be
// missed.
func (f *fixture) leftovers(t *testing.T, project uuid.UUID, apps, keys []uuid.UUID) []string {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND column_name IN ('project_id', 'app_id', 'key_id', 'monitor_app_id')
		  AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`)
	if err != nil {
		t.Fatal(err)
	}
	type col struct{ table, column string }
	var cols []col
	for rows.Next() {
		var c col
		if err := rows.Scan(&c.table, &c.column); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	cols = append(cols, col{"apps", "id"}, col{"api_keys", "id"})
	var out []string
	for _, c := range cols {
		if _, kept := keptTables[c.table]; kept {
			continue
		}
		ids := []uuid.UUID{project}
		switch c.column {
		case "app_id", "monitor_app_id":
			ids = apps
		case "key_id":
			ids = keys
		case "id":
			ids = append(append([]uuid.UUID{}, apps...), keys...)
		}
		var n int
		if err := f.pool.QueryRow(f.ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s = ANY($1::uuid[])`, c.table, c.column), ids).Scan(&n); err != nil {
			t.Fatalf("%s.%s: %v", c.table, c.column, err)
		}
		if n > 0 {
			out = append(out, fmt.Sprintf("%s.%s: %d rows", c.table, c.column, n))
		}
	}
	for _, table := range purge.ClickHouseTables {
		var n uint64
		if err := f.ch.QueryRow(f.ctx, fmt.Sprintf("SELECT count() FROM %s WHERE project_id = ?", table), project).Scan(&n); err != nil {
			t.Fatalf("clickhouse %s: %v", table, err)
		}
		if n > 0 {
			out = append(out, fmt.Sprintf("clickhouse %s: %d rows", table, n))
		}
	}
	var cursor uint64
	ids := append([]uuid.UUID{project}, append(apps, keys...)...)
	for {
		entry, err := f.vk.Do(f.ctx, f.vk.B().Scan().Cursor(cursor).Match("apilens:*").Build()).AsScanEntry()
		if err != nil {
			t.Fatal(err)
		}
		for _, k := range entry.Elements {
			for _, id := range ids {
				if strings.Contains(k, id.String()) {
					out = append(out, "valkey "+k)
				}
			}
		}
		if cursor = entry.Cursor; cursor == 0 {
			break
		}
	}
	if n := f.relationships(t, project); n > 0 {
		out = append(out, fmt.Sprintf("spicedb: %d relationships", n))
	}
	return out
}

func (f *fixture) ids(t *testing.T, project uuid.UUID) (apps, keys []uuid.UUID) {
	t.Helper()
	q := db.New(f.pool)
	apps, err := q.ListPurgeAppIDs(f.ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	keys, err = q.ListPurgeKeyIDs(f.ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	if len(apps) == 0 || len(keys) == 0 {
		t.Fatalf("project %s has %d apps and %d keys; the fixture is broken", project, len(apps), len(keys))
	}
	return apps, keys
}

func (f *fixture) step(t *testing.T, project uuid.UUID) string {
	t.Helper()
	var step string
	if err := f.pool.QueryRow(f.ctx, `SELECT step FROM project_purges WHERE project_id = $1`, project).Scan(&step); err != nil {
		t.Fatal(err)
	}
	return step
}

func TestPurgeRemovesTheProjectEverywhere(t *testing.T) {
	f := setup(t)
	mineApps, mineKeys := f.ids(t, f.mine.ProjectID)
	theirApps, theirKeys := f.ids(t, f.theirs.ProjectID)
	if got := f.leftovers(t, f.mine.ProjectID, mineApps, mineKeys); len(got) == 0 {
		t.Fatal("the fixture left the project without data to purge")
	}
	f.deleteProject(t, f.mine)

	n, err := f.purger.PurgeDue(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d projects, want 1", n)
	}
	if _, err := f.relay.Drain(f.ctx); err != nil {
		t.Fatal(err)
	}

	if got := f.leftovers(t, f.mine.ProjectID, mineApps, mineKeys); len(got) > 0 {
		t.Errorf("the purged project still has data:\n%s", strings.Join(got, "\n"))
	}
	theirs := f.leftovers(t, f.theirs.ProjectID, theirApps, theirKeys)
	for _, want := range []string{"apps.project_id", "api_keys.project_id", "environments.project_id", "saved_views.project_id",
		"clickhouse api_requests", "clickhouse api_consumers", "valkey apilens:ingest:usage:", "spicedb:"} {
		if !containsPrefix(theirs, want) {
			t.Errorf("the other project lost %s (has %v)", want, theirs)
		}
	}
	if len(f.files.removed) != 1 || f.files.removed[0] != "export-shop" {
		t.Errorf("removed export files %v, want [export-shop]", f.files.removed)
	}

	q := db.New(f.pool)
	// The slug moves to the 30-day reservation.
	taken, err := q.ProjectSlugTaken(f.ctx, db.ProjectSlugTakenParams{Slug: "shop", ReservedAfter: time.Now().Add(-30 * 24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if !taken {
		t.Error("the purged project's slug is free at once; want it reserved for 30 days")
	}
	free, err := q.ProjectSlugTaken(f.ctx, db.ProjectSlugTakenParams{Slug: "shop", ReservedAfter: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if free {
		t.Error("the purged project still holds its slug outside the reservation")
	}
	// project.purged is org-scoped and has no actor.
	var org uuid.UUID
	var label string
	if err := f.pool.QueryRow(f.ctx, `SELECT org_id, target_label FROM audit_events
		WHERE event = 'project.purged' AND target_id = $1 AND project_id IS NULL AND actor_user_id IS NULL`, f.mine.ProjectID.String()).Scan(&org, &label); err != nil {
		t.Fatalf("project.purged: %v", err)
	}
	if org != f.mine.OrgID || label == "" {
		t.Errorf("project.purged org %s label %q, want org %s and the project's name", org, label, f.mine.OrgID)
	}
	if got := f.step(t, f.mine.ProjectID); got != "done" {
		t.Errorf("purge step %q, want done", got)
	}

	// Nothing is due any more; purging again does nothing.
	if n, err := f.purger.PurgeDue(f.ctx); err != nil || n != 0 {
		t.Errorf("second run purged %d (%v), want 0", n, err)
	}
	if err := f.purger.Purge(f.ctx, f.mine.ProjectID); err != nil {
		t.Errorf("purging a purged project: %v", err)
	}
	var events int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM audit_events WHERE event = 'project.purged'`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Errorf("%d project.purged events, want 1", events)
	}
}

func TestPurgeResumesAfterAnInterruptedRun(t *testing.T) {
	f := setup(t)
	apps, keys := f.ids(t, f.mine.ProjectID)
	f.deleteProject(t, f.mine)

	// The run stops at the files step, after ClickHouse and Valkey.
	f.files.fail = errors.New("disk unavailable")
	if _, err := f.purger.PurgeDue(f.ctx); err == nil {
		t.Fatal("the interrupted run reported success")
	}
	if got := f.step(t, f.mine.ProjectID); got != "files" {
		t.Fatalf("purge step after the interruption %q, want files", got)
	}
	var lastErr *string
	if err := f.pool.QueryRow(f.ctx, `SELECT last_error FROM project_purges WHERE project_id = $1`, f.mine.ProjectID).Scan(&lastErr); err != nil {
		t.Fatal(err)
	}
	if lastErr == nil || !strings.Contains(*lastErr, "disk unavailable") {
		t.Errorf("last_error %v, want the failure", lastErr)
	}

	// The next run picks it up and finishes.
	f.files.fail = nil
	n, err := f.purger.PurgeDue(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged %d projects, want 1", n)
	}
	if _, err := f.relay.Drain(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.leftovers(t, f.mine.ProjectID, apps, keys); len(got) > 0 {
		t.Errorf("the resumed purge left data:\n%s", strings.Join(got, "\n"))
	}
	var attempts int
	if err := f.pool.QueryRow(f.ctx, `SELECT attempts FROM project_purges WHERE project_id = $1`, f.mine.ProjectID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Errorf("attempts %d, want 2", attempts)
	}
}

func TestPurgeDueSelection(t *testing.T) {
	f := setup(t)
	q := db.New(f.pool)
	due := func() []uuid.UUID {
		ids, err := q.ListPurgeDueProjects(f.ctx, db.ListPurgeDueProjectsParams{OrgGraceSeconds: int64(grace / time.Second), MaxProjects: 10})
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	if got := due(); len(got) != 0 {
		t.Fatalf("active projects are due: %v", got)
	}
	// Inside the grace period: not due, and the operator command refuses an
	// active project.
	exec(t, f.pool, `UPDATE projects SET deleted_at = now(), purge_after = now() + interval '7 days' WHERE id = $1`, f.mine.ProjectID)
	if got := due(); len(got) != 0 {
		t.Fatalf("a project inside its grace period is due: %v", got)
	}
	if err := f.purger.Purge(f.ctx, f.theirs.ProjectID); !errors.Is(err, purge.ErrNotDeleted) {
		t.Fatalf("purging an active project: %v, want ErrNotDeleted", err)
	}
	if err := f.purger.Purge(f.ctx, uuid.New()); !errors.Is(err, purge.ErrNotFound) {
		t.Fatalf("purging an unknown project: %v, want ErrNotFound", err)
	}
	// Organization deletes: its projects are due once the same grace has
	// passed.
	exec(t, f.pool, `UPDATE organizations SET deleted_at = now() - interval '1 day' WHERE id = $1`, f.theirs.OrgID)
	if got := due(); len(got) != 0 {
		t.Fatalf("projects of an org deleted a day ago are due: %v", got)
	}
	exec(t, f.pool, `UPDATE organizations SET deleted_at = now() - interval '8 days' WHERE id = $1`, f.theirs.OrgID)
	if got := due(); len(got) != 1 || got[0] != f.theirs.ProjectID {
		t.Fatalf("due %v, want the project of the deleted org %s", got, f.theirs.ProjectID)
	}
	apps, keys := f.ids(t, f.theirs.ProjectID)
	if n, err := f.purger.PurgeDue(f.ctx); err != nil || n != 1 {
		t.Fatalf("purged %d (%v), want 1", n, err)
	}
	if _, err := f.relay.Drain(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.leftovers(t, f.theirs.ProjectID, apps, keys); len(got) > 0 {
		t.Errorf("the deleted org's project still has data:\n%s", strings.Join(got, "\n"))
	}
	// The operator command purges inside the grace period.
	apps, keys = f.ids(t, f.mine.ProjectID)
	if err := f.purger.Purge(f.ctx, f.mine.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.relay.Drain(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.leftovers(t, f.mine.ProjectID, apps, keys); len(got) > 0 {
		t.Errorf("the operator purge left data:\n%s", strings.Join(got, "\n"))
	}
}

func containsPrefix(list []string, prefix string) bool {
	for _, s := range list {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}
