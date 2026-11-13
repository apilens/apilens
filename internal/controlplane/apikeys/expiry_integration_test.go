//go:build integration

package apikeys_test

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

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

type expiryFixture struct {
	ctx     context.Context
	pool    *pgxpool.Pool
	expiry  *apikeys.Expiry
	now     time.Time
	project uuid.UUID
	keys    map[string]uuid.UUID
}

func (f *expiryFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// addKey inserts a key of the project expiring at expires (nil: never).
func (f *expiryFixture) addKey(t *testing.T, name string, expires *time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	_, _, hash, err := apikeys.Generate()
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO api_keys (id, project_id, name, prefix, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
		id, f.project, name, "apl_live_"+name, hash, expires)
	f.keys[name] = id
	return id
}

// drainEmails returns and deletes the queued email.send jobs.
func (f *expiryFixture) drainEmails(t *testing.T) []email.SendArgs {
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

// expiredEvents returns the key ids of the api_key.expired events, oldest
// first, and checks each has no actor and the project scope.
func (f *expiryFixture) expiredEvents(t *testing.T) []uuid.UUID {
	t.Helper()
	rows, err := f.pool.Query(f.ctx, `SELECT target_id, actor_user_id, project_id, target_type FROM audit_events
		WHERE event = $1 ORDER BY id`, string(audit.APIKeyExpired))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var target, typ string
		var actor, project *uuid.UUID
		if err := rows.Scan(&target, &actor, &project, &typ); err != nil {
			t.Fatal(err)
		}
		if actor != nil || project == nil || *project != f.project || typ != "api_key" {
			t.Errorf("event for %s: actor %v, project %v, target type %q", target, actor, project, typ)
		}
		ids = append(ids, uuid.MustParse(target))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func (f *expiryFixture) run(t *testing.T) apikeys.ExpiryResult {
	t.Helper()
	res, err := f.expiry.Run(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// TestExpiry runs the expiry job against a fake clock: one reminder for the
// key expiring within 7 days, one api_key.expired for the key past its
// expiry, nothing for keys in a rotation overlap, revoked keys, keys of
// deleted projects or keys far from expiry, and nothing twice.
func TestExpiry(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	f := &expiryFixture{
		ctx: ctx, pool: pool, project: uuid.New(), keys: map[string]uuid.UUID{},
		now: time.Date(2030, 3, 1, 12, 0, 0, 0, time.UTC),
	}
	f.expiry = apikeys.NewExpiry(pool, audit.New(pool), jc, testutil.Logger(t)).WithClock(func() time.Time { return f.now })

	org := uuid.New()
	f.exec(t, `INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, org)
	f.exec(t, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'shop', 'Shop')`, f.project, org)
	for _, u := range []struct{ name, role, prefs string }{
		{"owner", "owner", `{}`},
		{"quiet", "admin", `{"security_emails": false}`},
		{"member", "member", `{}`},
	} {
		id := uuid.New()
		f.exec(t, `INSERT INTO users (id, email, name, preferences) VALUES ($1, $2, $3, $4::jsonb)`,
			id, "expiry-"+u.name+"@example.com", "User "+u.name, u.prefs)
		f.exec(t, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)`, org, id, u.role)
	}
	at := func(d time.Duration) *time.Time { v := f.now.Add(d); return &v }
	day := 24 * time.Hour

	f.addKey(t, "soon", at(3*day))
	f.addKey(t, "later", at(10*day))
	f.addKey(t, "past", at(-time.Hour))
	f.addKey(t, "never", nil)
	successor := f.addKey(t, "successor", nil)
	rotated := f.addKey(t, "rotated", at(day))
	f.exec(t, `UPDATE api_keys SET rotated_to = $1 WHERE id = $2`, successor, rotated)
	f.exec(t, `UPDATE api_keys SET rotated_from = $1 WHERE id = $2`, rotated, successor)
	revoked := f.addKey(t, "revoked", at(-time.Hour))
	f.exec(t, `UPDATE api_keys SET revoked_at = $1 WHERE id = $2`, f.now.Add(-2*time.Hour), revoked)
	// A key of a deleted project gets nothing.
	gone := uuid.New()
	f.exec(t, `INSERT INTO projects (id, org_id, slug, name, deleted_at) VALUES ($1, $2, 'gone', 'Gone', now())`, gone, org)
	_, _, hash, _ := apikeys.Generate()
	f.exec(t, `INSERT INTO api_keys (id, project_id, name, prefix, key_hash, expires_at) VALUES ($1, $2, 'gone', 'apl_live_gone', $3, $4)`,
		uuid.New(), gone, hash, at(2*day))

	t.Run("one reminder and one expired event", func(t *testing.T) {
		res := f.run(t)
		if res != (apikeys.ExpiryResult{Reminded: 1, Emails: 1, Expired: 1}) {
			t.Fatalf("result = %+v", res)
		}
		got := f.drainEmails(t)
		if len(got) != 1 {
			t.Fatalf("emails = %+v; want one, to the owner", got)
		}
		a := got[0]
		if a.To != "expiry-owner@example.com" || a.Template != email.TemplateAPIKeyExpiring ||
			a.Data["key"] != "soon" || a.Data["prefix"] != "apl_live_soon" || a.Data["project"] != "Shop" ||
			a.Data["slug"] != "shop" || a.Data["expires_at"] != f.now.Add(3*day).Format(time.RFC3339) {
			t.Errorf("email = %+v", a)
		}
		if ids := f.expiredEvents(t); !slices.Equal(ids, []uuid.UUID{f.keys["past"]}) {
			t.Errorf("expired events for %v; want only past", ids)
		}
		// The queued reminder renders, after the job's JSON round trip.
		r, err := email.DefaultRenderer(email.WithPublicUIURL("https://app.example.com"))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(a.Data)
		var data map[string]any
		_ = json.Unmarshal(raw, &data)
		if _, err := r.Render(a.Template, a.To, data); err != nil {
			t.Error(err)
		}
	})

	t.Run("nothing twice", func(t *testing.T) {
		if res := f.run(t); res != (apikeys.ExpiryResult{}) {
			t.Fatalf("second run = %+v; want nothing", res)
		}
		if got := f.drainEmails(t); len(got) != 0 {
			t.Fatalf("second run emailed %+v", got)
		}
	})

	t.Run("later run: the reminded key expires, the next one is reminded, rotated keys stay silent", func(t *testing.T) {
		f.now = f.now.Add(4 * day) // soon and rotated have expired; later is 6 days away
		res := f.run(t)
		if res != (apikeys.ExpiryResult{Reminded: 1, Emails: 1, Expired: 1}) {
			t.Fatalf("result = %+v", res)
		}
		got := f.drainEmails(t)
		if len(got) != 1 || got[0].Data["key"] != "later" {
			t.Fatalf("emails = %+v; want one for later", got)
		}
		if ids := f.expiredEvents(t); !slices.Equal(ids, []uuid.UUID{f.keys["past"], f.keys["soon"]}) {
			t.Errorf("expired events for %v; want past then soon", ids)
		}
		var notified, recorded *time.Time
		if err := pool.QueryRow(ctx, `SELECT expiry_notified_at, expired_recorded_at FROM api_keys WHERE id = $1`, rotated).
			Scan(&notified, &recorded); err != nil {
			t.Fatal(err)
		}
		if notified != nil || recorded != nil {
			t.Errorf("rotated key: notified %v, recorded %v; want neither", notified, recorded)
		}
	})
}
