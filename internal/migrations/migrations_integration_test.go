//go:build integration

package migrations_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
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
	for _, want := range []string{"api_keys", "apps", "audit_events", "auth_email_tokens", "backup_codes", "environments", "invitations", "memberships", "oauth_identities", "org_sso_connections", "organizations", "outbox", "passkey_credentials", "projects", "recovery_requests", "sessions", "signing_keys", "user_totp", "users", "river_job", "river_migration", "river_queue"} {
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

func TestPostgresEmailTokensMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'tok@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO auth_email_tokens (id, email, intent, user_id, link_token_hash, code_hash, next_path, ip, expires_at)
		VALUES (gen_random_uuid(), 'tok@example.com', $1, $2, $3, 'c', $4, '203.0.113.7', now() + interval '15 minutes')`
	if _, err := pool.Exec(ctx, insert, "signin", userID, "l1", "/projects/x?tab=y"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, "signup", nil, "l2", nil); err != nil {
		t.Fatalf("signup without a user or next_path: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, "signin", nil, "l1", nil); err == nil {
		t.Fatal("duplicate link_token_hash should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insert, "reset_password", nil, "l3", nil); err == nil {
		t.Fatal("unknown intent should violate the check")
	}
	for _, ok := range []string{"/", "/projects", "/a/b?c=d#e", "/" + strings.Repeat("a", 511)} {
		if _, err := pool.Exec(ctx, insert, "verify_email", nil, "ok"+ok, ok); err != nil {
			t.Errorf("next_path %q should be accepted: %v", ok, err)
		}
	}
	for i, bad := range []string{
		"", "projects", "https://evil.example", "//evil.example", "/\\evil.example",
		"/a b", "/a\tb", "/a\nb", "javascript:alert(1)", "/" + strings.Repeat("a", 512),
	} {
		if _, err := pool.Exec(ctx, insert, "change_email", nil, fmt.Sprintf("bad%d", i), bad); err == nil {
			t.Errorf("next_path %q should violate the check", bad)
		}
	}
	var attempts int
	var userAgent string
	if err := pool.QueryRow(ctx, `SELECT attempts, user_agent FROM auth_email_tokens WHERE link_token_hash = 'l1'`).Scan(&attempts, &userAgent); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || userAgent != "" {
		t.Errorf("defaults = %d, %q; want 0, empty", attempts, userAgent)
	}
	// Deleting the user cascades to their tokens; tokens without a user stay.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM auth_email_tokens WHERE link_token_hash IN ('l1', 'l2')`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("tokens after user delete = %d, %v; want 1", n, err)
	}

	if _, err := provider.DownTo(ctx, 4); err != nil {
		t.Fatalf("roll back to 00004: %v", err)
	}
	if tableExists(t, pool, "auth_email_tokens") {
		t.Error("auth_email_tokens should be dropped after rollback")
	}
	if !tableExists(t, pool, "sessions") || !tableExists(t, pool, "users") {
		t.Error("rollback of 00005 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "auth_email_tokens") {
		t.Error("auth_email_tokens missing after re-apply")
	}
}

func TestPostgresOAuthIdentitiesMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID, otherID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'oauth@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'other@example.com') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO oauth_identities (id, user_id, provider, subject, email) VALUES (gen_random_uuid(), $1, $2, $3, $4)`
	if _, err := pool.Exec(ctx, insert, userID, "google", "g-1", "oauth@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, userID, "github", "1234", nil); err != nil {
		t.Fatalf("second provider for the same user, without an email: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, otherID, "github", "g-1", nil); err != nil {
		t.Fatalf("same subject under another provider: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, otherID, "google", "g-1", nil); err == nil {
		t.Fatal("a (provider, subject) linked to another user should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insert, userID, "gitlab", "x", nil); err == nil {
		t.Fatal("unknown provider should violate the check")
	}
	if _, err := pool.Exec(ctx, insert, userID, "google", "", nil); err == nil {
		t.Fatal("empty subject should violate the check")
	}
	var profile string
	var lastLogin *time.Time
	if err := pool.QueryRow(ctx, `SELECT profile::text, last_login_at FROM oauth_identities WHERE provider = 'google' AND subject = 'g-1'`).Scan(&profile, &lastLogin); err != nil {
		t.Fatal(err)
	}
	if profile != "{}" || lastLogin != nil {
		t.Errorf("defaults = %q, %v; want {}, NULL", profile, lastLogin)
	}
	var usesIndex bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'oauth_identities' AND indexname = 'oauth_identities_user')`).Scan(&usesIndex); err != nil || !usesIndex {
		t.Errorf("oauth_identities_user index missing: %v", err)
	}
	// Deleting a user cascades to their identities only.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM oauth_identities`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("identities after user delete = %d, %v; want 1", n, err)
	}

	if _, err := provider.DownTo(ctx, 5); err != nil {
		t.Fatalf("roll back to 00005: %v", err)
	}
	if tableExists(t, pool, "oauth_identities") {
		t.Error("oauth_identities should be dropped after rollback")
	}
	if !tableExists(t, pool, "auth_email_tokens") || !tableExists(t, pool, "users") {
		t.Error("rollback of 00006 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "oauth_identities") {
		t.Error("oauth_identities missing after re-apply")
	}
}

func TestPostgresPasskeysMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID, otherID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'passkey@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'other@example.com') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, name) VALUES (gen_random_uuid(), $1, $2, $3, $4)`
	key := []byte{0xa5, 0x01, 0x02}
	if _, err := pool.Exec(ctx, insert, userID, []byte("cred-1"), key, "MacBook"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insert, userID, []byte("cred-2"), key, "iPhone"); err != nil {
		t.Fatalf("second passkey for the same user: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, otherID, []byte("cred-1"), key, "Stolen"); err == nil {
		t.Fatal("a credential_id registered to another user should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insert, userID, []byte{}, key, "Empty"); err == nil {
		t.Fatal("empty credential_id should violate the check")
	}
	if _, err := pool.Exec(ctx, insert, userID, []byte("cred-3"), []byte{}, "No key"); err == nil {
		t.Fatal("empty public_key should violate the check")
	}
	if _, err := pool.Exec(ctx, insert, userID, []byte("cred-3"), key, ""); err == nil {
		t.Fatal("empty name should violate the check")
	}
	if _, err := pool.Exec(ctx, insert, userID, []byte("cred-3"), key, strings.Repeat("n", 65)); err == nil {
		t.Fatal("a name over 64 characters should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE passkey_credentials SET sign_count = -1 WHERE credential_id = 'cred-1'`); err == nil {
		t.Fatal("negative sign_count should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE passkey_credentials SET sign_count = 4294967296 WHERE credential_id = 'cred-1'`); err == nil {
		t.Fatal("sign_count above uint32 should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE passkey_credentials SET backup_state = true WHERE credential_id = 'cred-1'`); err == nil {
		t.Fatal("backup_state without backup_eligible should violate the check")
	}
	var (
		attestation, aaguid string
		signCount           int64
		transports          []string
		be, bs              bool
		lastUsed            *time.Time
	)
	if err := pool.QueryRow(ctx, `SELECT attestation_type, aaguid::text, sign_count, transports, backup_eligible, backup_state, last_used_at
		FROM passkey_credentials WHERE credential_id = 'cred-1'`).Scan(&attestation, &aaguid, &signCount, &transports, &be, &bs, &lastUsed); err != nil {
		t.Fatal(err)
	}
	if attestation != "" || aaguid != "00000000-0000-0000-0000-000000000000" || signCount != 0 || len(transports) != 0 || be || bs || lastUsed != nil {
		t.Errorf("defaults = %q %q %d %v %v %v %v", attestation, aaguid, signCount, transports, be, bs, lastUsed)
	}
	var hasIndex bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'passkey_credentials' AND indexname = 'passkey_credentials_user')`).Scan(&hasIndex); err != nil || !hasIndex {
		t.Errorf("passkey_credentials_user index missing: %v", err)
	}
	if _, err := pool.Exec(ctx, insert, otherID, []byte("cred-9"), key, "YubiKey"); err != nil {
		t.Fatal(err)
	}
	// Deleting a user cascades to their passkeys only.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM passkey_credentials`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("passkeys after user delete = %d, %v; want 1", n, err)
	}

	if _, err := provider.DownTo(ctx, 6); err != nil {
		t.Fatalf("roll back to 00006: %v", err)
	}
	if tableExists(t, pool, "passkey_credentials") {
		t.Error("passkey_credentials should be dropped after rollback")
	}
	if !tableExists(t, pool, "oauth_identities") || !tableExists(t, pool, "users") {
		t.Error("rollback of 00007 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "passkey_credentials") {
		t.Error("passkey_credentials missing after re-apply")
	}
}

func TestPostgresTOTPMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID, otherID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'totp@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'other@example.com') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}

	// user_totp: one row per user, ciphertext required.
	insertTOTP := `INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, $2)`
	if _, err := pool.Exec(ctx, insertTOTP, userID, []byte{0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertTOTP, userID, []byte{0x03}); err == nil {
		t.Fatal("a second secret for the same user should violate the primary key")
	}
	if _, err := pool.Exec(ctx, insertTOTP, otherID, []byte{}); err == nil {
		t.Fatal("empty secret_enc should violate the check")
	}
	if _, err := pool.Exec(ctx, insertTOTP, otherID, []byte{0x04}); err != nil {
		t.Fatal(err)
	}
	var confirmed *time.Time
	if err := pool.QueryRow(ctx, `SELECT confirmed_at FROM user_totp WHERE user_id = $1`, userID).Scan(&confirmed); err != nil || confirmed != nil {
		t.Fatalf("confirmed_at default = %v, %v; want NULL", confirmed, err)
	}

	// backup_codes: a hash is unique per user, not globally.
	insertCode := `INSERT INTO backup_codes (id, user_id, code_hash) VALUES (gen_random_uuid(), $1, $2)`
	if _, err := pool.Exec(ctx, insertCode, userID, "h1"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertCode, userID, "h1"); err == nil {
		t.Fatal("the same code_hash twice for one user should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insertCode, otherID, "h1"); err != nil {
		t.Fatalf("the same code_hash for another user: %v", err)
	}
	if _, err := pool.Exec(ctx, insertCode, userID, ""); err == nil {
		t.Fatal("empty code_hash should violate the check")
	}

	// recovery_requests: unique token, cooling-off after the request, one end state.
	insertReq := `INSERT INTO recovery_requests (id, user_id, token_hash, ready_at, ip) VALUES ($1, $2, $3, $4, '203.0.113.7')`
	r1 := "00000000-0000-0000-0000-000000000001"
	if _, err := pool.Exec(ctx, insertReq, r1, userID, "t1", time.Now().Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertReq, "00000000-0000-0000-0000-000000000002", otherID, "t1", time.Now().Add(24*time.Hour)); err == nil {
		t.Fatal("duplicate token_hash should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insertReq, "00000000-0000-0000-0000-000000000003", userID, "", time.Now().Add(24*time.Hour)); err == nil {
		t.Fatal("empty token_hash should violate the check")
	}
	if _, err := pool.Exec(ctx, insertReq, "00000000-0000-0000-0000-000000000004", userID, "t4", time.Now().Add(-time.Hour)); err == nil {
		t.Fatal("ready_at before requested_at should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE recovery_requests SET confirmed_at = now(), cancelled_at = now() WHERE id = $1`, r1); err == nil {
		t.Fatal("a request both confirmed and cancelled should violate the check")
	}
	if _, err := pool.Exec(ctx, insertReq, "00000000-0000-0000-0000-000000000005", otherID, "t5", time.Now().Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var userAgent string
	if err := pool.QueryRow(ctx, `SELECT user_agent FROM recovery_requests WHERE id = $1`, r1).Scan(&userAgent); err != nil || userAgent != "" {
		t.Fatalf("user_agent default = %q, %v; want empty", userAgent, err)
	}
	var hasIndex bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'recovery_requests' AND indexname = 'recovery_requests_user')`).Scan(&hasIndex); err != nil || !hasIndex {
		t.Errorf("recovery_requests_user index missing: %v", err)
	}

	// Deleting a user cascades to their rows in all three tables only.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"user_totp", "backup_codes", "recovery_requests"} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil || n != 1 {
			t.Errorf("%s rows after user delete = %d, %v; want 1", table, n, err)
		}
	}

	if _, err := provider.DownTo(ctx, 7); err != nil {
		t.Fatalf("roll back to 00007: %v", err)
	}
	for _, table := range []string{"user_totp", "backup_codes", "recovery_requests"} {
		if tableExists(t, pool, table) {
			t.Errorf("table %q should be dropped after rollback", table)
		}
	}
	if !tableExists(t, pool, "passkey_credentials") || !tableExists(t, pool, "users") {
		t.Error("rollback of 00008 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	for _, table := range []string{"user_totp", "backup_codes", "recovery_requests"} {
		if !tableExists(t, pool, table) {
			t.Errorf("table %q missing after re-apply", table)
		}
	}
}

func TestPostgresMembershipsMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var userID, otherID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'owner@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'other@example.com') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}

	// organizations: new columns with defaults; allowed_domains lower-case only.
	var orgID string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (id, slug, name, created_by) VALUES (gen_random_uuid(), 'acme', 'Acme', $1) RETURNING id`, userID).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	var domains []string
	var domainJoin bool
	if err := pool.QueryRow(ctx, `SELECT allowed_domains, domain_join FROM organizations WHERE id = $1`, orgID).Scan(&domains, &domainJoin); err != nil {
		t.Fatal(err)
	}
	if len(domains) != 0 || domainJoin {
		t.Errorf("defaults = %v, %v; want {}, false", domains, domainJoin)
	}
	if _, err := pool.Exec(ctx, `UPDATE organizations SET allowed_domains = '{acme.com,acme.io}', domain_join = true WHERE id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE organizations SET allowed_domains = '{Acme.com}' WHERE id = $1`, orgID); err == nil {
		t.Fatal("an upper-case allowed domain should violate the check")
	}

	// memberships: one row per (org, user), known roles only.
	insertMember := `INSERT INTO memberships (org_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)`
	if _, err := pool.Exec(ctx, insertMember, orgID, userID, "owner", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertMember, orgID, userID, "admin", nil); err == nil {
		t.Fatal("a second membership for the same (org, user) should violate the primary key")
	}
	if _, err := pool.Exec(ctx, insertMember, orgID, otherID, "superuser", nil); err == nil {
		t.Fatal("unknown role should violate the check")
	}
	if _, err := pool.Exec(ctx, insertMember, orgID, otherID, "viewer", userID); err != nil {
		t.Fatal(err)
	}
	// The database does not guard the last owner; that is the service layer's job.
	if _, err := pool.Exec(ctx, `UPDATE memberships SET role = 'member' WHERE org_id = $1 AND user_id = $2`, orgID, userID); err != nil {
		t.Fatalf("demoting the last owner is a service-layer rule, not SQL: %v", err)
	}

	// invitations: one pending per (org, email) case-insensitively, 7-day default expiry.
	insertInvite := `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5, $6)`
	i1 := "00000000-0000-0000-0000-000000000001"
	if _, err := pool.Exec(ctx, insertInvite, i1, orgID, "New@Example.com", "member", "t1", userID); err != nil {
		t.Fatal(err)
	}
	var ttlSeconds int64
	if err := pool.QueryRow(ctx, `SELECT extract(epoch FROM expires_at - created_at)::bigint FROM invitations WHERE id = $1`, i1).Scan(&ttlSeconds); err != nil {
		t.Fatal(err)
	}
	if ttl := time.Duration(ttlSeconds) * time.Second; ttl != 7*24*time.Hour {
		t.Errorf("default expiry = %v after creation; want 7 days", ttl)
	}
	if _, err := pool.Exec(ctx, insertInvite, "00000000-0000-0000-0000-000000000002", orgID, "new@example.com", "admin", "t2", nil); err == nil {
		t.Fatal("a second pending invitation for the same address should violate invitations_org_email_pending")
	}
	if _, err := pool.Exec(ctx, insertInvite, "00000000-0000-0000-0000-000000000003", orgID, "x@example.com", "member", "t1", nil); err == nil {
		t.Fatal("duplicate token_hash should violate the unique constraint")
	}
	if _, err := pool.Exec(ctx, insertInvite, "00000000-0000-0000-0000-000000000004", orgID, "y@example.com", "root", "t4", nil); err == nil {
		t.Fatal("unknown role should violate the check")
	}
	if _, err := pool.Exec(ctx, insertInvite, "00000000-0000-0000-0000-000000000005", orgID, "z@example.com", "member", "", nil); err == nil {
		t.Fatal("empty token_hash should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE invitations SET accepted_at = now(), revoked_at = now() WHERE id = $1`, i1); err == nil {
		t.Fatal("an invitation both accepted and revoked should violate the check")
	}
	if _, err := pool.Exec(ctx, `UPDATE invitations SET revoked_at = now() WHERE id = $1`, i1); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertInvite, "00000000-0000-0000-0000-000000000006", orgID, "new@example.com", "admin", "t6", nil); err != nil {
		t.Fatalf("a revoked invitation frees the address for a new one: %v", err)
	}

	// Deleting a user cascades to their memberships and nulls invited_by/created_by.
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	var members, invitedBy int
	if err := pool.QueryRow(ctx, `SELECT count(*), count(invited_by) FROM memberships`).Scan(&members, &invitedBy); err != nil || members != 1 || invitedBy != 0 {
		t.Fatalf("memberships after user delete = %d (invited_by set %d), %v; want 1 (0)", members, invitedBy, err)
	}
	var createdBy *string
	if err := pool.QueryRow(ctx, `SELECT created_by::text FROM organizations WHERE id = $1`, orgID).Scan(&createdBy); err != nil || createdBy != nil {
		t.Fatalf("created_by after user delete = %v, %v; want NULL", createdBy, err)
	}

	if _, err := provider.DownTo(ctx, 8); err != nil {
		t.Fatalf("roll back to 00008: %v", err)
	}
	for _, table := range []string{"memberships", "invitations"} {
		if tableExists(t, pool, table) {
			t.Errorf("table %q should be dropped after rollback", table)
		}
	}
	var cols int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'organizations' AND column_name IN ('allowed_domains', 'domain_join', 'created_by')`).Scan(&cols); err != nil || cols != 0 {
		t.Errorf("organizations domain-join columns after rollback = %d, %v; want 0", cols, err)
	}
	if !tableExists(t, pool, "organizations") || !tableExists(t, pool, "user_totp") {
		t.Error("rollback of 00009 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	for _, table := range []string{"memberships", "invitations"} {
		if !tableExists(t, pool, table) {
			t.Errorf("table %q missing after re-apply", table)
		}
	}
}

func TestPostgresOrgSSOMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}

	var orgID, otherID string
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (id, slug, name) VALUES (gen_random_uuid(), 'acme', 'Acme') RETURNING id`).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO organizations (id, slug, name) VALUES (gen_random_uuid(), 'other', 'Other') RETURNING id`).Scan(&otherID); err != nil {
		t.Fatal(err)
	}

	// One connection per organization, with defaults.
	insertConn := `INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc) VALUES ($1, $2, $3, $4)`
	if _, err := pool.Exec(ctx, insertConn, orgID, "https://idp.example.com", "client", []byte{0x01}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertConn, orgID, "https://idp2.example.com", "client2", []byte{0x02}); err == nil {
		t.Fatal("a second connection for the same organization should violate the primary key")
	}
	var domains []string
	var enforce bool
	var role string
	var lastLogin *time.Time
	if err := pool.QueryRow(ctx, `SELECT domains, enforce, default_role, last_login_at FROM org_sso_connections WHERE org_id = $1`, orgID).
		Scan(&domains, &enforce, &role, &lastLogin); err != nil {
		t.Fatal(err)
	}
	if len(domains) != 0 || enforce || role != "member" || lastLogin != nil {
		t.Errorf("defaults = %v, %v, %q, %v; want {}, false, member, NULL", domains, enforce, role, lastLogin)
	}

	// Required, non-empty settings.
	for name, args := range map[string][]any{
		"empty issuer":        {otherID, "", "client", []byte{0x01}},
		"empty client_id":     {otherID, "https://idp.example.com", "", []byte{0x01}},
		"empty client secret": {otherID, "https://idp.example.com", "client", []byte{}},
	} {
		if _, err := pool.Exec(ctx, insertConn, args...); err == nil {
			t.Errorf("%s should violate a check", name)
		}
	}

	// Domains are lower-case; default_role is never owner.
	if _, err := pool.Exec(ctx, `UPDATE org_sso_connections SET domains = '{acme.com,acme.io}', enforce = true, default_role = 'viewer' WHERE org_id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE org_sso_connections SET domains = '{Acme.com}' WHERE org_id = $1`, orgID); err == nil {
		t.Fatal("an upper-case domain should violate the check")
	}
	for _, bad := range []string{"owner", "superuser"} {
		if _, err := pool.Exec(ctx, `UPDATE org_sso_connections SET default_role = $2 WHERE org_id = $1`, orgID, bad); err == nil {
			t.Errorf("default_role %q should violate the check", bad)
		}
	}
	var hasIndex bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'org_sso_connections' AND indexname = 'org_sso_connections_domains')`).Scan(&hasIndex); err != nil || !hasIndex {
		t.Errorf("org_sso_connections_domains index missing: %v", err)
	}

	// Deleting an organization cascades to its connection only.
	if _, err := pool.Exec(ctx, insertConn, otherID, "https://idp.example.com", "client", []byte{0x01}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM org_sso_connections`).Scan(&n); err != nil || n != 1 {
		t.Errorf("connections after organization delete = %d, %v; want 1", n, err)
	}

	if _, err := provider.DownTo(ctx, 9); err != nil {
		t.Fatalf("roll back to 00009: %v", err)
	}
	if tableExists(t, pool, "org_sso_connections") {
		t.Error("table org_sso_connections should be dropped after rollback")
	}
	if !tableExists(t, pool, "memberships") || !tableExists(t, pool, "organizations") {
		t.Error("rollback of 00010 must not touch earlier migrations")
	}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "org_sso_connections") {
		t.Error("table org_sso_connections missing after re-apply")
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

func TestPostgresOAuthProviderMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"oauth_clients", "oauth_auth_requests", "oauth_tokens"} {
		if !tableExists(t, pool, name) {
			t.Fatalf("table %s missing", name)
		}
	}

	insertClient := `INSERT INTO oauth_clients (id, secret_hash, auth_method, grant_types) VALUES ($1, $2, $3, $4)`
	if _, err := pool.Exec(ctx, insertClient, "web", "hash", "client_secret_basic", []string{"authorization_code", "refresh_token"}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertClient, "cli", nil, "none", []string{"authorization_code"}); err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string][]any{
		"public with secret":       {"c1", "hash", "none", []string{}},
		"confidential, no secret":  {"c2", nil, "client_secret_basic", []string{}},
		"unknown grant":            {"c3", "hash", "client_secret_basic", []string{"password"}},
		"unknown auth method":      {"c4", "hash", "private_key_jwt", []string{}},
		"public client_credential": {"c5", nil, "none", []string{"client_credentials"}},
	} {
		if _, err := pool.Exec(ctx, insertClient, args...); err == nil {
			t.Errorf("%s should violate a check", name)
		}
	}

	var userID string
	if err := pool.QueryRow(ctx, `INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'ada@example.com') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	insertReq := `INSERT INTO oauth_auth_requests (id, client_id, redirect_uri, response_type, expires_at, user_id, auth_time, code_hash)
		VALUES (gen_random_uuid(), 'web', 'https://client.example.com/cb', 'code', now() + interval '10 minutes', $1, $2, $3)`
	if _, err := pool.Exec(ctx, insertReq, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertReq, userID, time.Now(), "code-hash"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertReq, nil, nil, "other-hash"); err == nil {
		t.Error("a code for a request nobody signed in to should violate a check")
	}
	if _, err := pool.Exec(ctx, insertReq, userID, nil, nil); err == nil {
		t.Error("a user without auth_time should violate a check")
	}

	insertToken := `INSERT INTO oauth_tokens (id, client_id, user_id, expires_at, refresh_token_hash, refresh_expires_at)
		VALUES (gen_random_uuid(), 'web', $1, now() + interval '15 minutes', $2, $3)`
	if _, err := pool.Exec(ctx, insertToken, nil, nil, nil); err != nil {
		t.Fatal("a client token:", err)
	}
	if _, err := pool.Exec(ctx, insertToken, userID, "rt", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertToken, nil, "rt2", time.Now().Add(time.Hour)); err == nil {
		t.Error("a refresh token without a user should violate a check")
	}
	if _, err := pool.Exec(ctx, insertToken, userID, "rt3", nil); err == nil {
		t.Error("a refresh token without a lifetime should violate a check")
	}

	// Deleting a client cascades to its requests and tokens.
	if _, err := pool.Exec(ctx, `DELETE FROM oauth_clients WHERE id = 'web'`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_auth_requests) + (SELECT count(*) FROM oauth_tokens)`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows left after client delete = %d, %v; want 0", n, err)
	}

	if _, err := provider.DownTo(ctx, 10); err != nil {
		t.Fatalf("roll back to 00010: %v", err)
	}
	for _, name := range []string{"oauth_clients", "oauth_auth_requests", "oauth_tokens"} {
		if tableExists(t, pool, name) {
			t.Errorf("table %s should be dropped after rollback", name)
		}
	}
	if !tableExists(t, pool, "org_sso_connections") {
		t.Error("rollback of 00011 must not touch earlier migrations")
	}
	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply after rollback: %v", err)
	}
	if !tableExists(t, pool, "oauth_tokens") {
		t.Error("table oauth_tokens missing after re-apply")
	}
}

func TestPostgresDefaultAppsMigrationBackfills(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.PostgresFS())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.DownTo(ctx, 11); err != nil {
		t.Fatalf("roll back to 00011: %v", err)
	}

	// bare: no app (created through the API before 00012), backfilled;
	// seeded: already has an app, left alone; gone: soft-deleted, left alone.
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES (gen_random_uuid(), 'acme', 'Acme')`); err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct{ slug, deleted string }{{"bare", "NULL"}, {"seeded", "NULL"}, {"gone", "now()"}} {
		q := fmt.Sprintf(`INSERT INTO projects (id, org_id, slug, name, deleted_at)
			SELECT gen_random_uuid(), id, $1::text, upper($1::text), %s FROM organizations WHERE slug = 'acme'`, p.deleted)
		if _, err := pool.Exec(ctx, q, p.slug); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO apps (id, project_id, slug, name)
		SELECT gen_random_uuid(), id, 'storefront', 'Storefront' FROM projects WHERE slug = 'seeded'`); err != nil {
		t.Fatal(err)
	}

	apps := func() []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT p.slug || ':' || a.slug || ':' || a.name FROM apps a JOIN projects p ON p.id = a.project_id
			WHERE a.deleted_at IS NULL ORDER BY 1`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		return out
	}
	want := []string{"bare:bare:BARE", "seeded:storefront:Storefront"}

	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("apply 00012: %v", err)
	}
	if got := apps(); !slices.Equal(got, want) {
		t.Fatalf("apps after backfill = %v, want %v", got, want)
	}

	// Down is a no-op and re-applying does not duplicate.
	if _, err := provider.DownTo(ctx, 11); err != nil {
		t.Fatalf("roll back 00012: %v", err)
	}
	if err := migrations.UpPostgres(ctx, pool, testutil.Logger(t)); err != nil {
		t.Fatalf("re-apply 00012: %v", err)
	}
	if got := apps(); !slices.Equal(got, want) {
		t.Fatalf("apps after re-apply = %v, want %v", got, want)
	}
}
