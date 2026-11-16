//go:build integration

package notify_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/notify"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

type fixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	n       *notify.Notifier
	project uuid.UUID
	users   map[string]uuid.UUID
}

// setup is org acme with an owner, an org admin, a member with a direct
// admin grant, an org admin who turned security emails off, a plain member,
// an editor by direct grant and a viewer, and project shop (default access
// org_role).
func setup(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{ctx: ctx, pool: pool, n: notify.New(jc), project: uuid.New(), users: map[string]uuid.UUID{}}
	org := uuid.New()
	f.exec(t, `INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, org)
	f.exec(t, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'shop', 'Shop')`, f.project, org)
	for _, u := range []struct{ name, orgRole, direct, prefs string }{
		{"owner", "owner", "", `{}`},
		{"admin", "admin", "", `{"security_emails": true}`},
		{"direct", "member", "admin", `{}`},
		{"quiet", "admin", "", `{"security_emails": false}`},
		{"member", "member", "", `{}`},
		{"editor", "viewer", "editor", `{}`},
		{"viewer", "viewer", "", `{}`},
	} {
		id := uuid.New()
		f.users[u.name] = id
		f.exec(t, `INSERT INTO users (id, email, name, preferences) VALUES ($1, $2, $3, $4::jsonb)`,
			id, "notify-"+u.name+"@example.com", "User "+u.name, u.prefs)
		f.exec(t, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)`, org, id, u.orgRole)
		if u.direct != "" {
			f.exec(t, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)`, f.project, id, u.direct)
		}
	}
	// A deleted org admin gets nothing.
	gone := uuid.New()
	f.exec(t, `INSERT INTO users (id, email, deleted_at) VALUES ($1, 'notify-gone@example.com', now())`, gone)
	f.exec(t, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, org, gone)
	return f
}

func (f *fixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// notify runs ProjectAdmins in a transaction, committing it unless rollback.
func (f *fixture) notify(t *testing.T, ev notify.Event, rollback bool) int {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	n, err := f.n.ProjectAdmins(f.ctx, tx, f.project, ev)
	if err != nil {
		t.Fatal(err)
	}
	if !rollback {
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	return n
}

// drain returns and deletes the queued email.send jobs.
func (f *fixture) drain(t *testing.T) []email.SendArgs {
	t.Helper()
	var out []email.SendArgs
	err := pgx.BeginFunc(f.ctx, f.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(f.ctx, `DELETE FROM river_job WHERE kind = 'email.send' RETURNING args`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				return err
			}
			var a email.SendArgs
			if err := json.Unmarshal(raw, &a); err != nil {
				return err
			}
			out = append(out, a)
		}
		return rows.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func recipients(args []email.SendArgs) []string {
	var to []string
	for _, a := range args {
		to = append(to, a.To)
	}
	slices.Sort(to)
	return to
}

func TestProjectAdmins(t *testing.T) {
	f := setup(t)

	t.Run("actor excluded and preference respected", func(t *testing.T) {
		n := f.notify(t, notify.Event{Change: notify.KeyCreated, Actor: f.users["admin"], Detail: "checkout"}, false)
		got := f.drain(t)
		want := []string{"notify-direct@example.com", "notify-owner@example.com"}
		if n != len(want) || !slices.Equal(recipients(got), want) {
			t.Fatalf("sent %d to %v; want %v", n, recipients(got), want)
		}
		for _, a := range got {
			if a.Template != email.TemplateProjectChange || a.Data["change"] != "api_key_created" ||
				a.Data["actor"] != "User admin" || a.Data["detail"] != "checkout" ||
				a.Data["project"] != "Shop" || a.Data["slug"] != "shop" {
				t.Errorf("job = %+v", a)
			}
		}
	})

	t.Run("default access wording", func(t *testing.T) {
		f.notify(t, notify.Event{Change: notify.DefaultAccessChanged, Actor: f.users["owner"], Detail: "none"}, false)
		got := f.drain(t)
		if want := []string{"notify-admin@example.com", "notify-direct@example.com"}; !slices.Equal(recipients(got), want) {
			t.Fatalf("sent to %v; want %v", recipients(got), want)
		}
		if d, _ := got[0].Data["detail"].(string); d == "" || d == "none" {
			t.Errorf("detail = %q; want the wording", d)
		}
	})

	t.Run("deletion always sent", func(t *testing.T) {
		f.exec(t, `UPDATE projects SET deleted_at = now() WHERE id = $1`, f.project)
		t.Cleanup(func() { f.exec(t, `UPDATE projects SET deleted_at = NULL WHERE id = $1`, f.project) })
		purge := time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)
		f.notify(t, notify.Event{Change: notify.DeletionScheduled, Actor: f.users["owner"], PurgeAt: purge}, false)
		got := f.drain(t)
		want := []string{"notify-admin@example.com", "notify-direct@example.com", "notify-quiet@example.com"}
		if !slices.Equal(recipients(got), want) {
			t.Fatalf("sent to %v; want %v", recipients(got), want)
		}
		for _, a := range got {
			if a.Template != email.TemplateProjectDeletionScheduled || a.Data["purge_at"] != "2026-11-20T09:00:00Z" {
				t.Errorf("job = %+v", a)
			}
		}
	})

	t.Run("system actor emails every admin", func(t *testing.T) {
		f.notify(t, notify.Event{Change: notify.Paused}, false)
		got := f.drain(t)
		if want := []string{"notify-admin@example.com", "notify-direct@example.com", "notify-owner@example.com"}; !slices.Equal(recipients(got), want) {
			t.Fatalf("sent to %v; want %v", recipients(got), want)
		}
		if got[0].Data["actor"] != notify.SystemActor {
			t.Errorf("actor = %v", got[0].Data["actor"])
		}
	})

	t.Run("rolled back change sends nothing", func(t *testing.T) {
		f.notify(t, notify.Event{Change: notify.KeyRevoked, Actor: f.users["owner"], Detail: "checkout"}, true)
		if got := f.drain(t); len(got) != 0 {
			t.Fatalf("sent %v after rollback", recipients(got))
		}
	})

	t.Run("every queued email renders", func(t *testing.T) {
		r, err := email.DefaultRenderer(email.WithPublicUIURL("https://app.example.com"))
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range []notify.Event{
			{Change: notify.KeyRotated, Detail: "checkout"},
			{Change: notify.DefaultAccessChanged, Detail: "viewer"},
			{Change: notify.Restored}, {Change: notify.Resumed},
			{Change: notify.DeletionScheduled, PurgeAt: time.Now().Add(7 * 24 * time.Hour)},
		} {
			f.notify(t, ev, false)
			for _, a := range f.drain(t) {
				// The job data goes through JSON, as in the worker.
				raw, _ := json.Marshal(a.Data)
				var data map[string]any
				_ = json.Unmarshal(raw, &data)
				if _, err := r.Render(a.Template, a.To, data); err != nil {
					t.Errorf("%s: %v", ev.Change, err)
				}
			}
		}
	})
}
