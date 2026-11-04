//go:build integration

package migrations_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/testutil"
)

func TestMigrationsApplyAndAreIdempotent(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)

	pool := testutil.MigratedPostgres(t)
	if err := migrations.UpPostgres(ctx, pool, logger); err != nil {
		t.Fatalf("second postgres run should be a no-op: %v", err)
	}
	if err := migrations.UpRiver(ctx, pool, logger); err != nil {
		t.Fatalf("second river run should be a no-op: %v", err)
	}
	var tables []string
	rows, err := pool.Query(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	for _, want := range []string{"api_keys", "apps", "audit_events", "environments", "organizations", "outbox", "projects", "sessions", "signing_keys", "users", "river_job", "river_migration", "river_queue"} {
		if !slices.Contains(tables, want) {
			t.Errorf("postgres table %q missing (have %v)", want, tables)
		}
	}

	chCfg := testutil.ClickHouse(t)
	chCfg.Database = "apilens_migrations" // also proves the database is created on demand
	for i := range 2 {
		if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
			t.Fatalf("clickhouse run %d: %v", i+1, err)
		}
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	var names []string
	chRows, err := conn.Query(ctx, "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	for chRows.Next() {
		var name string
		if err := chRows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	_ = chRows.Close()
	for _, want := range []string{"api_deploys", "api_logs", "api_requests", "api_requests_1h", "api_requests_1h_mv", "api_requests_1m", "api_requests_1m_mv", "api_spans"} {
		if !slices.Contains(names, want) {
			t.Errorf("clickhouse table %q missing (have %v)", want, names)
		}
	}
}

func TestPostgresUsersMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	// Active emails are unique case-insensitively; a soft-deleted user frees it.
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'Ada@Example.com')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'ada@example.com')`); err == nil {
		t.Fatal("duplicate active email (different case) should violate users_email_active")
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET deleted_at = now()`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'ada@example.com')`); err != nil {
		t.Fatalf("email of a deleted user should be reusable: %v", err)
	}
	var prefs, onboarding string
	if err := pool.QueryRow(ctx, `SELECT preferences::text, onboarding::text FROM users WHERE deleted_at IS NULL`).Scan(&prefs, &onboarding); err != nil {
		t.Fatal(err)
	}
	if prefs != "{}" || onboarding != "{}" {
		t.Errorf("jsonb defaults = %q, %q; want {}", prefs, onboarding)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO audit_events (user_id, actor_user_id, event, ip, metadata)
		SELECT id, id, 'user.login', '203.0.113.7', '{"method":"magic_link"}' FROM users WHERE deleted_at IS NULL`); err != nil {
		t.Fatal(err)
	}

	if _, err := provider.DownTo(ctx, 1); err != nil {
		t.Fatalf("roll back to 00001: %v", err)
	}
	for _, table := range []string{"users", "audit_events"} {
		if tableExists(t, pool, table) {
			t.Errorf("table %q should be dropped after rollback", table)
		}
	}
	if !tableExists(t, pool, "organizations") {
		t.Error("rollback of 00002 must not touch the baseline schema")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "users") {
		t.Error("users missing after re-apply")
	}
}

func TestPostgresSigningKeysMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	insert := `INSERT INTO signing_keys (kid, alg, public_jwk, private_key_enc, activated_at, retired_at)
		VALUES ($1, 'RS256', '{"kty":"RSA"}', '\x01', $2, $3)`
	day := func(d int) *time.Time { ts := time.Date(2026, 1, d, 0, 0, 0, 0, time.UTC); return &ts }
	if _, err := pool.Exec(ctx, insert, "k1", day(1), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, "k2", day(2), nil); err == nil {
		t.Fatal("a second active key should violate signing_keys_one_active")
	}
	if _, err := pool.Exec(ctx, insert, "k3", nil, day(2)); err == nil {
		t.Fatal("a retired key must have been activated")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO signing_keys (kid, alg, public_jwk, private_key_enc) VALUES ('k4', 'HS256', '{}', '\x01')`); err == nil {
		t.Fatal("only RS256 keys are allowed")
	}
	if _, err := pool.Exec(ctx, insert, "k5", day(1), day(2)); err != nil {
		t.Fatalf("retired keys do not count towards the one active key: %v", err)
	}

	if _, err := provider.DownTo(ctx, 2); err != nil {
		t.Fatalf("roll back to 00002: %v", err)
	}
	if tableExists(t, pool, "signing_keys") {
		t.Error("signing_keys should be dropped after rollback")
	}
	if !tableExists(t, pool, "users") {
		t.Error("rollback of 00003 must not touch 00002")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "signing_keys") {
		t.Error("signing_keys missing after re-apply")
	}
}

func TestPostgresSessionsMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'sess@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO sessions (id, user_id, family_id, token_hash, amr, ip, expires_at)
		VALUES ($1, $2, $1, $3, '{otp}', '203.0.113.7', now() + interval '1 day')`
	s1 := "00000000-0000-0000-0000-000000000001"
	if _, err := pool.Exec(ctx, insert, s1, userID, "h1"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, "00000000-0000-0000-0000-000000000002", userID, "h1"); err == nil {
		t.Fatal("duplicate token_hash should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE id = $1`, s1); err == nil {
		t.Fatal("revoked_at without revoked_reason should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, s1); err != nil {
		t.Fatal(err)
	}
	var remember bool
	var userAgent, label string
	if err := pool.QueryRow(ctx, `SELECT remember, user_agent, device_label FROM sessions WHERE id = $1`, s1).Scan(&remember, &userAgent, &label); err != nil {
		t.Fatal(err)
	}
	if remember || userAgent != "" || label != "" {
		t.Errorf("defaults = %v, %q, %q; want false, empty, empty", remember, userAgent, label)
	}
	// Deleting the user cascades to their sessions.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("sessions after user delete = %d, %v; want 0", n, err)
	}

	if _, err := provider.DownTo(ctx, 3); err != nil {
		t.Fatalf("roll back to 00003: %v", err)
	}
	if tableExists(t, pool, "sessions") {
		t.Error("sessions should be dropped after rollback")
	}
	if !tableExists(t, pool, "signing_keys") || !tableExists(t, pool, "users") {
		t.Error("rollback of 00004 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "sessions") {
		t.Error("sessions missing after re-apply")
	}
}

func tableExists(t *testing.T, pool *pgxpool.Pool, name string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(t.Context(), `SELECT to_regclass('public.' || $1) IS NOT NULL`, name).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}
