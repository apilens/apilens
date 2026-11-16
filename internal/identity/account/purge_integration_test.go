//go:build integration

package account_test

import (
	"context"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

// newUser creates a user with a session, an email token and two audit
// events (one about them, one they acted in on another user's account).
func newUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string, other *uuid.UUID) uuid.UUID {
	t.Helper()
	q := db.New(pool)
	u, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: email, Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions (id, user_id, family_id, token_hash, expires_at)
		VALUES ($1, $2, $1, $3, now() + interval '1 day')`, uuid.New(), u.ID, "h-"+email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_email_tokens (id, email, intent, user_id, link_token_hash, code_hash, expires_at)
		VALUES ($1, $2, 'signin', $3, $4, 'c', now() + interval '15 minutes')`, uuid.New(), email, u.ID, "l-"+email); err != nil {
		t.Fatal(err)
	}
	rec := audit.New(pool)
	if err := rec.Record(ctx, audit.Event{User: &u.ID, Actor: &u.ID, Kind: audit.UserUpdated, Meta: map[string]any{"fields": []string{"name"}}}); err != nil {
		t.Fatal(err)
	}
	if other != nil {
		if err := rec.Record(ctx, audit.Event{User: other, Actor: &u.ID, Kind: audit.MemberRoleChanged, Meta: map[string]any{"role": "admin"}}); err != nil {
			t.Fatal(err)
		}
	}
	return u.ID
}

func count(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPurgeJob(t *testing.T) {
	pool := testutil.MigratedPostgres(t)
	ctx := audit.WithRequest(context.Background(), audit.Request{IP: netip.MustParseAddr("203.0.113.9"), UserAgent: "itest"})
	svc := account.New(pool, nil)

	keep := newUser(t, ctx, pool, "keep@example.com", nil)
	expired := newUser(t, ctx, pool, "expired@example.com", &keep)
	grace := newUser(t, ctx, pool, "grace@example.com", nil)
	for _, id := range []uuid.UUID{expired, grace} {
		if _, err := svc.Delete(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	// expired's grace period is over; grace's is not.
	if _, err := pool.Exec(ctx, `UPDATE users SET delete_after = now() - interval '1 hour' WHERE id = $1`, expired); err != nil {
		t.Fatal(err)
	}
	// An org-scoped event about expired, acted in by them: org history that
	// must outlive the person.
	orgID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO audit_events (user_id, actor_user_id, event, ip, user_agent, org_id, actor_label, target_type, target_id, target_label)
		VALUES ($1, $1, $2, '203.0.113.9', 'itest', $3, 'Ada', 'member', $4, 'expired@example.com')`, expired, string(audit.MemberJoined), orgID, expired.String()); err != nil {
		t.Fatal(err)
	}
	personalEvents := count(t, ctx, pool, `SELECT count(*) FROM audit_events WHERE user_id = $1 AND org_id IS NULL`, expired)
	if personalEvents == 0 {
		t.Fatal("expired has no personal events to purge")
	}

	// The hourly periodic job runs on start and purges.
	reg := jobs.NewRegistry()
	jobs.Register(reg, account.NewPurgeWorker(pool, testutil.Logger(t)))
	reg.Periodic(account.PurgeInterval, account.PurgeArgs{})
	c, err := jobs.New(pool, config.JobsConfig{Enabled: true, MaxWorkers: 2, MetricsInterval: time.Second}, reg, 10*time.Second, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(runCtx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("jobs: %v", err)
		}
	})

	deadline := time.Now().Add(30 * time.Second)
	for count(t, ctx, pool, `SELECT count(*) FROM users WHERE id = $1`, expired) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("expired user was not purged")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Credentials and sessions cascade.
	for _, tc := range []struct{ name, sql string }{
		{"sessions", `SELECT count(*) FROM sessions WHERE user_id = $1`},
		{"email tokens", `SELECT count(*) FROM auth_email_tokens WHERE user_id = $1`},
		{"audit events naming the user", `SELECT count(*) FROM audit_events WHERE user_id = $1 OR actor_user_id = $1`},
	} {
		if n := count(t, ctx, pool, tc.sql, expired); n != 0 {
			t.Errorf("%s left: %d", tc.name, n)
		}
	}
	// The purged user's personal events (no org) are deleted.
	if n := count(t, ctx, pool, `SELECT count(*) FROM audit_events WHERE user_id IS NULL AND org_id IS NULL`); n != 0 {
		t.Errorf("personal events left = %d, want 0", n)
	}
	// Org-scoped events are kept, anonymised, with the actor's name at the
	// time; the one they acted in on keep's account keeps its subject but
	// loses actor and client.
	if n := count(t, ctx, pool, `SELECT count(*) FROM audit_events WHERE org_id = $1 AND user_id IS NULL AND actor_user_id IS NULL
		AND ip IS NULL AND user_agent = '' AND actor_label = 'Ada' AND target_label = 'expired@example.com'`, orgID); n != 1 {
		t.Errorf("kept org events = %d, want 1", n)
	}
	if n := count(t, ctx, pool, `SELECT count(*) FROM audit_events WHERE user_id = $1 AND event = $2
		AND actor_user_id IS NULL AND ip IS NULL AND user_agent = '' AND metadata->>'role' = 'admin'`, keep, string(audit.MemberRoleChanged)); n != 1 {
		t.Errorf("acted-in event on keep's account = %d, want 1", n)
	}

	// Users inside their grace period, and active users, are untouched.
	if n := count(t, ctx, pool, `SELECT count(*) FROM users WHERE id = ANY($1)`, []uuid.UUID{keep, grace}); n != 2 {
		t.Fatalf("remaining users = %d, want 2", n)
	}
	if n := count(t, ctx, pool, `SELECT count(*) FROM sessions WHERE user_id = $1`, grace); n != 1 {
		t.Errorf("grace sessions = %d, want 1 (revoked, not purged)", n)
	}
	if n := count(t, ctx, pool, `SELECT count(*) FROM audit_events WHERE user_id = $1 AND ip IS NOT NULL`, keep); n == 0 {
		t.Error("keep's own audit events were anonymised")
	}

	// A second run finds nothing to purge.
	if n, err := account.Purge(ctx, pool); err != nil || n != 0 {
		t.Fatalf("second purge = %d (%v)", n, err)
	}
}
