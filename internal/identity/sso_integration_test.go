//go:build integration

package identity

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// sqlMemberships is the SSOMemberships of these tests. The control plane's
// orgs.Service.JoinViaSSO (which imports this package, so it cannot be used
// here) is tested against Postgres in internal/controlplane/orgs.
type sqlMemberships struct{ pool *pgxpool.Pool }

func (m sqlMemberships) JoinViaSSO(ctx context.Context, org, user uuid.UUID, role string) (bool, error) {
	tag, err := m.pool.Exec(ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, org, user, role)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// TestSSOIntegration runs start → fake OIDC provider → callback against
// Postgres (organizations, org_sso_connections, users, memberships,
// sessions, audit_events) and Valkey (state, pre-auth, handoff codes).
func TestSSOIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)

	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	keyNow := time.Now()
	k, err := signingkeys.Unstored(priv, &keyNow, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(itestKeys{k}, token.Options{Issuer: "https://id.example.com", TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.New(pool, issuer, session.Options{RefreshTTL: 720 * time.Hour, RefreshTTLShort: 24 * time.Hour}, logger)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	handoff := NewValkeyHandoffStore(vk)
	sealer := testSealer(t)
	idp := newFakeIdP(t)

	// Acme enforces SSO for acme.example.com; new members join as viewers.
	org := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES ($1, 'acme', 'Acme')`, org); err != nil {
		t.Fatal(err)
	}
	secret, err := SealSSOClientSecret(sealer, org, "sso-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc, domains, enforce, default_role)
		VALUES ($1, $2, 'g-id', $3, '{acme.example.com}', true, 'viewer')`, org, idp.srv.URL, secret); err != nil {
		t.Fatal(err)
	}

	cfg := config.IdentityConfig{Issuer: "https://id.example.com", PublicUIURL: testUIURL}
	s := NewSSO(cfg, NewValkeyOAuthStateStore(vk), SSODeps{
		Connections: q,
		Sealer:      sealer,
		Users:       NewPGSignInUsers(pool),
		Memberships: sqlMemberships{pool},
		Sessions:    sessions,
		PreAuth:     NewValkeyPreAuthStore(vk),
		Handoff:     handoff,
		Audit:       audit.New(pool),
	}, limiter, logger)
	_, api := humatest.New(t)
	s.Register(api)

	begin := func(t *testing.T, query string) startedFlow {
		t.Helper()
		resp := api.Get(ssoStartPath("acme", query))
		u := mustLocation(t, resp)
		if u.Query().Get("redirect_uri") != "https://id.example.com/api/v1/auth/sso/acme/callback" {
			t.Fatalf("authorize = %s", u)
		}
		return startedFlow{state: u.Query().Get("state"), challenge: u.Query().Get("code_challenge"), nonce: u.Query().Get("nonce")}
	}
	callback := func(t *testing.T, v url.Values) *url.URL {
		t.Helper()
		resp := api.Get(ssoCallbackPath("acme", v))
		if resp.Code != http.StatusFound {
			t.Fatalf("callback: %d %s", resp.Code, resp.Body)
		}
		u, err := url.Parse(resp.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	redeem := func(t *testing.T, loc *url.URL) SignInResponse {
		t.Helper()
		if loc.Path != "/auth/callback" {
			t.Fatalf("redirect = %s, want the UI callback", loc)
		}
		res, err := handoff.Take(ctx, loc.Query().Get("code"))
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	role := func(user uuid.UUID) string {
		t.Helper()
		var r string
		if err := pool.QueryRow(ctx, `SELECT coalesce((SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2), '')`, org, user).Scan(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}

	var ada db.User
	t.Run("first sign-in creates the user and joins the org", func(t *testing.T) {
		f := begin(t, "remember=true")
		idp.Grant("c1", ssoGrant(f, "Ada@ACME.example.com"))
		res := redeem(t, callback(t, url.Values{"code": {"c1"}, "state": {f.state}}))
		if res.AccessToken == "" || res.RefreshToken == "" || res.Next != users.OnboardingPath {
			t.Fatalf("handoff = %+v", res)
		}
		if ada, err = q.GetUserByEmail(ctx, "ada@acme.example.com"); err != nil {
			t.Fatal(err)
		}
		if ada.EmailVerifiedAt == nil || res.User.ID != ada.ID.String() {
			t.Fatalf("user = %+v", ada)
		}
		claims, err := issuer.Verify(res.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(claims.AMR, []string{"sso"}) {
			t.Fatalf("amr = %v", claims.AMR)
		}
		if r := role(ada.ID); r != "viewer" {
			t.Fatalf("role = %q", r)
		}
		conn, err := q.GetOrgSSOConnection(ctx, org)
		if err != nil || conn.LastLoginAt == nil {
			t.Fatalf("connection last_login_at = %v (%v)", conn.LastLoginAt, err)
		}
		var meta []byte
		if err := pool.QueryRow(ctx, `SELECT metadata FROM audit_events WHERE user_id = $1 AND event = 'login.succeeded'`, ada.ID).Scan(&meta); err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(meta, &m)
		if m["method"] != "sso" || m["joined"] != true || m["org_id"] != org.String() {
			t.Fatalf("login.succeeded = %v", m)
		}
	})

	t.Run("second sign-in keeps the membership", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE memberships SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, org, ada.ID); err != nil {
			t.Fatal(err)
		}
		f := begin(t, "next=/acme")
		idp.Grant("c2", ssoGrant(f, "ada@acme.example.com"))
		res := redeem(t, callback(t, url.Values{"code": {"c2"}, "state": {f.state}}))
		if res.User == nil || res.User.ID != ada.ID.String() || res.Next != "/acme" {
			t.Fatalf("handoff = %+v", res)
		}
		if r := role(ada.ID); r != "admin" {
			t.Fatalf("role = %q", r)
		}
	})

	t.Run("state is single use", func(t *testing.T) {
		f := begin(t, "")
		idp.Grant("c3", ssoGrant(f, "ada@acme.example.com"))
		redeem(t, callback(t, url.Values{"code": {"c3"}, "state": {f.state}}))
		wantSignInError(t, callback(t, url.Values{"code": {"c3"}, "state": {f.state}}), "oauth_state_mismatch")
	})

	t.Run("email outside the domains is refused", func(t *testing.T) {
		f := begin(t, "")
		idp.Grant("c4", ssoGrant(f, "eve@evil.example.com"))
		wantSignInError(t, callback(t, url.Values{"code": {"c4"}, "state": {f.state}}), "forbidden")
		if _, err := q.GetUserByEmail(ctx, "eve@evil.example.com"); err == nil {
			t.Fatal("user created")
		}
	})

	t.Run("a secret sealed for another org does not open", func(t *testing.T) {
		other, err := SealSSOClientSecret(sealer, uuid.New(), "sso-secret")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE org_sso_connections SET client_secret_enc = $2 WHERE org_id = $1`, org, other); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(ctx, `UPDATE org_sso_connections SET client_secret_enc = $2 WHERE org_id = $1`, org, secret)
		})
		f := begin(t, "")
		idp.Grant("c5", ssoGrant(f, "ada@acme.example.com"))
		wantSignInError(t, callback(t, url.Values{"code": {"c5"}, "state": {f.state}}), "internal_error")
	})

	t.Run("no connection answers 404", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES ($1, 'nosso', 'No SSO')`, uuid.New()); err != nil {
			t.Fatal(err)
		}
		if resp := api.Get(ssoStartPath("nosso", "")); resp.Code != http.StatusNotFound {
			t.Fatalf("start = %d", resp.Code)
		}
	})
}

// TestEmailStartSSOEnforcedIntegration checks that POST /auth/email/start
// refuses an address at a domain whose organization enforces SSO, with no
// email queued, against Postgres.
func TestEmailStartSSOEnforcedIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, logger, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range []struct {
		slug    string
		domain  string
		enforce bool
	}{{"acme", "acme.example.com", true}, {"beta", "beta.example.com", false}} {
		id := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, id, o.slug); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc, domains, enforce)
			VALUES ($1, 'https://idp.example.com', 'client', '\x01', ARRAY[$2], $3)`, id, o.domain, o.enforce); err != nil {
			t.Fatal(err)
		}
	}
	// An existing account at the enforced domain cannot use email either.
	if _, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@acme.example.com"}); err != nil {
		t.Fatal(err)
	}

	cfg := config.IdentityConfig{Issuer: "https://id.example.com"}
	cfg.RateLimits.EmailStartPerEmail = config.RateLimit{Limit: 10, Window: time.Minute}
	cfg.RateLimits.EmailStartPerIP = config.RateLimit{Limit: 100, Window: time.Minute}
	_, api := humatest.New(t)
	NewEmailStart(cfg, EmailStartDeps{
		Tokens: emailauth.New(emailauth.NewStore(pool), emailauth.Options{}),
		Users:  q,
		Jobs:   jc,
		Audit:  audit.New(pool),
		SSO:    NewSSOEnforcement(q, cfg.Issuer),
	}, limiter, logger).Register(api)
	count := func(sql string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	for _, addr := range []string{"ada@acme.example.com", "Nobody@Acme.Example.com"} {
		resp := api.Post(AuthPrefix+"/email/start", map[string]any{"email": addr, "intent": "signin"})
		if resp.Code != http.StatusForbidden {
			t.Fatalf("%s: %d %s", addr, resp.Code, resp.Body)
		}
		var p Problem
		if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != CodeSSORequired || p.StartURL != "https://id.example.com/api/v1/auth/sso/acme/start" {
			t.Fatalf("%s: problem = %+v", addr, p)
		}
	}
	if n := count(`SELECT count(*) FROM river_job WHERE kind = 'email.send'`); n != 0 {
		t.Fatalf("emails queued = %d", n)
	}
	if n := count(`SELECT count(*) FROM auth_email_tokens`); n != 0 {
		t.Fatalf("tokens issued = %d", n)
	}

	// A domain with SSO that is not enforced still gets its email.
	if resp := api.Post(AuthPrefix+"/email/start", map[string]any{"email": "bob@beta.example.com", "intent": "signup"}); resp.Code != http.StatusOK {
		t.Fatalf("beta: %d %s", resp.Code, resp.Body)
	}
	if n := count(`SELECT count(*) FROM river_job WHERE kind = 'email.send'`); n != 1 {
		t.Fatalf("emails queued = %d, want 1", n)
	}
}
