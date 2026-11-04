//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/testutil"
)

func TestIdentityRotateKey(t *testing.T) {
	env := []string{
		"APILENS_POSTGRES__URL=" + testutil.Postgres(t).URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_LOG__FORMAT=text",
	}
	var stderr bytes.Buffer
	if code := Main([]string{"migrate", "-only=postgres"}, &bytes.Buffer{}, &stderr, env); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, stderr.String())
	}

	type result struct {
		KID        string `json:"kid"`
		RetiredKID string `json:"retired_kid"`
	}
	rotate := func() result {
		t.Helper()
		var stdout, stderr bytes.Buffer
		if code := Main([]string{"identity", "rotate-key"}, &stdout, &stderr, env); code != 0 {
			t.Fatalf("rotate-key: exit %d: %s", code, stderr.String())
		}
		var r result
		if err := json.Unmarshal(stdout.Bytes(), &r); err != nil {
			t.Fatalf("rotate-key output %q: %v", stdout.String(), err)
		}
		return r
	}

	// On an empty table there is nothing to retire.
	first := rotate()
	if first.KID == "" || first.RetiredKID != "" {
		t.Fatalf("first rotation = %+v", first)
	}
	second := rotate()
	if second.KID == "" || second.KID == first.KID || second.RetiredKID != first.KID {
		t.Fatalf("second rotation = %+v, want retired %s", second, first.KID)
	}
}

func TestIdentityCreateClient(t *testing.T) {
	env := []string{
		"APILENS_POSTGRES__URL=" + testutil.Postgres(t).URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_LOG__FORMAT=text",
	}
	var stderr bytes.Buffer
	if code := Main([]string{"migrate", "-only=postgres"}, &bytes.Buffer{}, &stderr, env); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, stderr.String())
	}

	var stdout bytes.Buffer
	stderr.Reset()
	args := []string{"identity", "create-client", "-name=Agent", "-grant-types=client_credentials"}
	if code := Main(args, &stdout, &stderr, env); code != 0 {
		t.Fatalf("create-client: exit %d: %s", code, stderr.String())
	}
	var c struct {
		ClientID     string   `json:"client_id"`
		ClientSecret string   `json:"client_secret"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
		GrantTypes   []string `json:"grant_types"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &c); err != nil {
		t.Fatalf("create-client output %q: %v", stdout.String(), err)
	}
	if c.ClientID == "" || c.ClientSecret == "" || c.AuthMethod != "client_secret_basic" || len(c.GrantTypes) != 1 {
		t.Errorf("client = %+v", c)
	}

	// A public client cannot use client_credentials.
	stderr.Reset()
	args = []string{"identity", "create-client", "-public", "-grant-types=client_credentials"}
	if code := Main(args, &bytes.Buffer{}, &stderr, env); code == 0 {
		t.Error("a public client_credentials client was registered")
	}
}

// TestSeedAndUserCommands covers the self-host bootstrap: seed makes a dev
// owner with a working magic link, and `apilens user create|promote|
// magic-link` manage members with outbox rows and audit events.
func TestSeedAndUserCommands(t *testing.T) {
	ctx := context.Background()
	pgcfg := testutil.Postgres(t)
	env := []string{
		"APILENS_POSTGRES__URL=" + pgcfg.URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_IDENTITY__PUBLIC_UI_URL=https://ui.example.com/",
		"APILENS_LOG__FORMAT=text",
	}
	run := func(args ...string) (string, string, int) {
		t.Helper()
		var stdout, stderr bytes.Buffer
		code := Main(args, &stdout, &stderr, env)
		return stdout.String(), stderr.String(), code
	}
	mustRun := func(out any, args ...string) {
		t.Helper()
		stdout, stderr, code := run(args...)
		if code != 0 {
			t.Fatalf("%v: exit %d: %s", args, code, stderr)
		}
		if err := json.Unmarshal([]byte(stdout), out); err != nil {
			t.Fatalf("%v output %q: %v", args, stdout, err)
		}
	}
	if _, stderr, code := run("migrate", "-only=postgres"); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, stderr)
	}
	pool, err := pgxpool.New(ctx, pgcfg.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	role := func(email string) string {
		t.Helper()
		var r string
		err := pool.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
			JOIN organizations o ON o.id = m.org_id WHERE o.slug = 'dev' AND u.email = $1`, email).Scan(&r)
		if errors.Is(err, pgx.ErrNoRows) {
			return ""
		}
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	auditCount := func(event string) int {
		t.Helper()
		return count(`SELECT count(*) FROM audit_events WHERE event = $1`, event)
	}
	tokens := emailauth.New(emailauth.NewStore(pool), emailauth.Options{})
	useLink := func(link, email string) {
		t.Helper()
		const prefix = "https://ui.example.com/verify?"
		if !strings.HasPrefix(link, prefix) {
			t.Fatalf("magic link = %q, want prefix %q", link, prefix)
		}
		q, err := url.ParseQuery(strings.TrimPrefix(link, prefix))
		if err != nil {
			t.Fatal(err)
		}
		if q.Get("email") != email {
			t.Fatalf("link email = %q, want %q", q.Get("email"), email)
		}
		row, err := tokens.VerifyLink(ctx, q.Get("token"))
		if err != nil || row.Email != email || row.Intent != string(emailauth.IntentSignIn) {
			t.Fatalf("verify link: %+v, %v", row, err)
		}
	}

	// seed creates the dev owner and prints a working sign-in link.
	type seedOut struct {
		APIKey    string `json:"api_key"`
		UserID    string `json:"user_id"`
		UserEmail string `json:"user_email"`
		MagicLink string `json:"magic_link"`
	}
	var first seedOut
	mustRun(&first, "seed")
	if first.APIKey == "" || first.UserID == "" || first.UserEmail != "dev@apilens.local" {
		t.Fatalf("seed = %+v", first)
	}
	if got := role("dev@apilens.local"); got != "owner" {
		t.Fatalf("dev user role = %q, want owner", got)
	}
	useLink(first.MagicLink, "dev@apilens.local")
	if auditCount("member.added") != 1 || auditCount("user.created") != 1 || auditCount("login.requested") != 1 {
		t.Fatal("seed did not audit member.added, user.created and login.requested once each")
	}

	// A second seed reuses the user and membership and issues a fresh link.
	var second seedOut
	mustRun(&second, "seed")
	if second.UserID != first.UserID || second.MagicLink == first.MagicLink {
		t.Fatalf("second seed = %+v, first %+v", second, first)
	}
	if count(`SELECT count(*) FROM memberships`) != 1 || auditCount("member.added") != 1 {
		t.Fatal("second seed added a membership")
	}
	// -user-email= skips the user.
	var bare seedOut
	mustRun(&bare, "seed", "-user-email=")
	if bare.UserID != "" || bare.MagicLink != "" {
		t.Fatalf("seed -user-email= = %+v", bare)
	}

	// user create makes a new user and member.
	type member struct {
		UserID       string `json:"user_id"`
		Email        string `json:"email"`
		UserCreated  bool   `json:"user_created"`
		OrgSlug      string `json:"org_slug"`
		Role         string `json:"role"`
		PreviousRole string `json:"previous_role"`
	}
	var ops member
	mustRun(&ops, "user", "create", "--email=ops@example.com", "--org=dev", "--role=admin")
	if !ops.UserCreated || ops.Role != "admin" || ops.PreviousRole != "" || role("ops@example.com") != "admin" {
		t.Fatalf("user create = %+v", ops)
	}
	if count(`SELECT count(*) FROM outbox WHERE topic = 'membership.upserted'`) != 2 {
		t.Fatal("user create did not emit membership.upserted")
	}

	// promote defaults to owner and needs an existing user.
	var promoted member
	mustRun(&promoted, "user", "promote", "-email=ops@example.com", "-org=dev")
	if promoted.UserCreated || promoted.Role != "owner" || promoted.PreviousRole != "admin" || role("ops@example.com") != "owner" {
		t.Fatalf("user promote = %+v", promoted)
	}
	if auditCount("member.role_changed") != 1 {
		t.Fatal("promote did not audit member.role_changed")
	}
	if _, stderr, code := run("user", "promote", "-email=nobody@example.com", "-org=dev"); code == 0 || !strings.Contains(stderr, "user not found") {
		t.Fatalf("promote of an unknown user: exit %d: %s", code, stderr)
	}
	if _, stderr, code := run("user", "create", "-email=x@example.com", "-org=nope"); code == 0 || !strings.Contains(stderr, "organization not found") {
		t.Fatalf("create in an unknown org: exit %d: %s", code, stderr)
	}
	if _, _, code := run("user", "create", "-email=x@example.com", "-org=dev", "-role=superuser"); code == 0 {
		t.Fatal("an unknown role was accepted")
	}

	// With two owners one may be demoted, but never the last one.
	var demoted member
	mustRun(&demoted, "user", "promote", "-email=dev@apilens.local", "-org=dev", "-role=member")
	if demoted.PreviousRole != "owner" || role("dev@apilens.local") != "member" {
		t.Fatalf("demote = %+v", demoted)
	}
	if _, stderr, code := run("user", "promote", "-email=ops@example.com", "-org=dev", "-role=viewer"); code == 0 || !strings.Contains(stderr, "last owner") {
		t.Fatalf("demoting the last owner: exit %d: %s", code, stderr)
	}
	if role("ops@example.com") != "owner" {
		t.Fatal("the last owner was demoted")
	}

	// magic-link prints a working link for an existing user only.
	var link struct {
		Email     string `json:"email"`
		MagicLink string `json:"magic_link"`
	}
	mustRun(&link, "user", "magic-link", "-email=OPS@example.com")
	if link.Email != "ops@example.com" {
		t.Fatalf("magic-link = %+v", link)
	}
	useLink(link.MagicLink, "ops@example.com")
	if _, stderr, code := run("user", "magic-link", "-email=nobody@example.com"); code == 0 || !strings.Contains(stderr, "user not found") {
		t.Fatalf("magic-link for an unknown user: exit %d: %s", code, stderr)
	}
}
