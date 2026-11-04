//go:build integration

package identity

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestOAuthCallbackIntegration runs start → fake provider → callback against
// Postgres (users, oauth_identities, sessions, user_totp, audit_events) and
// Valkey (state, pre-auth, handoff codes), with an httptest Google (OIDC
// discovery, JWKS, signed id_tokens) and GitHub (token endpoint, /user,
// /user/emails).
func TestOAuthCallbackIntegration(t *testing.T) {
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

	cfg := testOAuthCfg
	cfg.PublicUIURL = testUIURL
	o := NewOAuth(cfg, NewValkeyOAuthStateStore(vk), limiter, logger).WithSignIn(OAuthSignInDeps{
		Users:    NewPGSignInUsers(pool),
		Sessions: sessions,
		PreAuth:  NewValkeyPreAuthStore(vk),
		Handoff:  handoff,
		Audit:    audit.New(pool),
	})
	idp := newFakeIdP(t)
	idp.Use(o)
	_, api := humatest.New(t)
	o.Register(api)

	callback := func(t *testing.T, provider string, v url.Values) *url.URL {
		t.Helper()
		resp := api.Get(callbackPath(provider, v))
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
		code := loc.Query().Get("code")
		ttl, err := vk.Do(ctx, vk.B().Ttl().Key(HandoffKey(code)).Build()).AsInt64()
		if err != nil || ttl <= 0 || ttl > 60 {
			t.Fatalf("handoff ttl = %d (%v), want 1..60 s", ttl, err)
		}
		res, err := handoff.Take(ctx, code)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := handoff.Take(ctx, code); !errors.Is(err, ErrHandoffNotFound) {
			t.Fatalf("second take: %v, want ErrHandoffNotFound", err)
		}
		return res
	}
	events := func(user uuid.UUID, kind audit.Kind) []map[string]any {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT metadata FROM audit_events WHERE user_id = $1 AND event = $2 ORDER BY id`, user, string(kind))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []map[string]any
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatal(err)
			}
			out = append(out, m)
		}
		return out
	}
	identities := func(user uuid.UUID) []db.OauthIdentity {
		t.Helper()
		ids, err := q.ListOAuthIdentitiesForUser(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}

	var ada db.User
	t.Run("google creates the user", func(t *testing.T) {
		f := beginOAuth(t, api, "google", "remember=true")
		idp.Grant("g1", googleGrant(f, "g-sub-ada", "Ada@Example.com"))
		res := redeem(t, callback(t, "google", url.Values{"code": {"g1"}, "state": {f.state}}))
		if res.AccessToken == "" || res.RefreshToken == "" || res.Next != users.OnboardingPath || res.User == nil {
			t.Fatalf("handoff = %+v", res)
		}
		if ada, err = q.GetUserByEmail(ctx, "ada@example.com"); err != nil {
			t.Fatal(err)
		}
		if res.User.ID != ada.ID.String() || ada.EmailVerifiedAt == nil {
			t.Fatalf("user = %+v", ada)
		}
		claims, err := issuer.Verify(res.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(claims.AMR, []string{"google"}) {
			t.Fatalf("amr = %v", claims.AMR)
		}
		ids := identities(ada.ID)
		if len(ids) != 1 || ids[0].Provider != "google" || ids[0].Subject != "g-sub-ada" || ids[0].LastLoginAt == nil {
			t.Fatalf("identities = %+v", ids)
		}
		if n := len(events(ada.ID, audit.UserCreated)); n != 1 {
			t.Fatalf("user.created = %d", n)
		}
		ok := events(ada.ID, audit.LoginSucceeded)
		if len(ok) != 1 || ok[0]["method"] != "google" || !slices.Equal(ok[0]["amr"].([]any), []any{"google"}) {
			t.Fatalf("login.succeeded = %+v", ok)
		}
	})

	t.Run("google again finds the user by subject", func(t *testing.T) {
		f := beginOAuth(t, api, "google", "next=/acme")
		// The provider now reports another address: the subject wins.
		idp.Grant("g2", googleGrant(f, "g-sub-ada", "ada.lovelace@example.com"))
		res := redeem(t, callback(t, "google", url.Values{"code": {"g2"}, "state": {f.state}}))
		if res.User == nil || res.User.ID != ada.ID.String() || res.Next != "/acme" {
			t.Fatalf("handoff = %+v", res)
		}
		ids := identities(ada.ID)
		if len(ids) != 1 || ids[0].Email == nil || *ids[0].Email != "ada.lovelace@example.com" {
			t.Fatalf("identities = %+v", ids)
		}
		if _, err := q.GetUserByEmail(ctx, "ada.lovelace@example.com"); err == nil {
			t.Fatal("a second user was created")
		}
	})

	t.Run("github links by verified email", func(t *testing.T) {
		f := beginOAuth(t, api, "github", "")
		idp.Grant("gh1", githubGrant(f, 1001, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		res := redeem(t, callback(t, "github", url.Values{"code": {"gh1"}, "state": {f.state}}))
		if res.User == nil || res.User.ID != ada.ID.String() || res.Next != "/" {
			t.Fatalf("handoff = %+v", res)
		}
		ids := identities(ada.ID)
		if len(ids) != 2 || ids[1].Provider != "github" || ids[1].Subject != "1001" {
			t.Fatalf("identities = %+v", ids)
		}
		ok := events(ada.ID, audit.LoginSucceeded)
		if last := ok[len(ok)-1]; last["method"] != "github" || !slices.Equal(last["amr"].([]any), []any{"github"}) {
			t.Fatalf("login.succeeded = %+v", last)
		}
	})

	t.Run("two-factor hands off a pre-auth token", func(t *testing.T) {
		if _, err := q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: ada.ID, SecretEnc: []byte("sealed")}); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ConfirmTOTP(ctx, ada.ID); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM user_totp WHERE user_id = $1`, ada.ID) })
		f := beginOAuth(t, api, "github", "")
		idp.Grant("gh2", githubGrant(f, 1001, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		res := redeem(t, callback(t, "github", url.Values{"code": {"gh2"}, "state": {f.state}}))
		if res.Status != TwoFactorRequiredStatus || res.PreAuthToken == "" || res.AccessToken != "" {
			t.Fatalf("handoff = %+v", res)
		}
		raw, err := vk.Do(ctx, vk.B().Get().Key(PreAuthKey(res.PreAuthToken)).Build()).AsBytes()
		if err != nil {
			t.Fatal(err)
		}
		var pre PreAuth
		if err := json.Unmarshal(raw, &pre); err != nil {
			t.Fatal(err)
		}
		if pre.UserID != ada.ID || !slices.Equal(pre.AMR, []string{"github"}) {
			t.Fatalf("pre-auth = %+v", pre)
		}
	})

	t.Run("state replay is a mismatch", func(t *testing.T) {
		f := beginOAuth(t, api, "github", "")
		idp.Grant("gh3", githubGrant(f, 2002, githubEmail{Email: "bob@example.com", Primary: true, Verified: true}))
		redeem(t, callback(t, "github", url.Values{"code": {"gh3"}, "state": {f.state}}))
		idp.Grant("gh4", githubGrant(f, 2002, githubEmail{Email: "bob@example.com", Primary: true, Verified: true}))
		loc := callback(t, "github", url.Values{"code": {"gh4"}, "state": {f.state}})
		if loc.Path != "/sign-in" || loc.Query().Get("error") != "oauth_state_mismatch" {
			t.Fatalf("replay redirect = %s", loc)
		}
	})

	t.Run("unverified email creates nobody", func(t *testing.T) {
		f := beginOAuth(t, api, "google", "")
		g := googleGrant(f, "g-sub-eve", "eve@example.com")
		g.claims["email_verified"] = false
		idp.Grant("g3", g)
		loc := callback(t, "google", url.Values{"code": {"g3"}, "state": {f.state}})
		if loc.Path != "/sign-in" || loc.Query().Get("error") != "oauth_email_unverified" {
			t.Fatalf("redirect = %s", loc)
		}
		if _, err := q.GetUserByEmail(ctx, "eve@example.com"); err == nil {
			t.Fatal("user created from an unverified email")
		}
		var failed int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = 'login.failed' AND metadata->>'code' = 'oauth_email_unverified'`).Scan(&failed); err != nil || failed != 1 {
			t.Fatalf("login.failed = %d (%v)", failed, err)
		}
	})

	t.Run("denied consent", func(t *testing.T) {
		f := beginOAuth(t, api, "github", "")
		loc := callback(t, "github", url.Values{"error": {"access_denied"}, "state": {f.state}})
		if loc.Path != "/sign-in" || loc.Query().Get("error") != CodeOAuthDenied {
			t.Fatalf("redirect = %s", loc)
		}
	})

	t.Run("deleted account cannot sign in", func(t *testing.T) {
		f := beginOAuth(t, api, "github", "")
		idp.Grant("gh5", githubGrant(f, 3003, githubEmail{Email: "gone@example.com", Primary: true, Verified: true}))
		res := redeem(t, callback(t, "github", url.Values{"code": {"gh5"}, "state": {f.state}}))
		if _, err := pool.Exec(ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, uuid.MustParse(res.User.ID)); err != nil {
			t.Fatal(err)
		}
		f = beginOAuth(t, api, "github", "")
		idp.Grant("gh6", githubGrant(f, 3003, githubEmail{Email: "gone@example.com", Primary: true, Verified: true}))
		loc := callback(t, "github", url.Values{"code": {"gh6"}, "state": {f.state}})
		if loc.Path != "/sign-in" || loc.Query().Get("error") != "account_deleting" {
			t.Fatalf("redirect = %s", loc)
		}
	})
}
