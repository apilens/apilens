//go:build integration

package identity

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

type reauthFixture struct {
	*passkeyFixture
}

// setupReauth serves the re-authentication endpoints (plus passkey
// registration and 2FA setup) over real Postgres and Valkey, with perUser
// as identity.rate_limits.second_factor_per_user. sso, when not nil, is the
// SSO enforcement lookup.
func setupReauth(t *testing.T, perUser config.RateLimit, sso SSOLookupStore) *reauthFixture {
	t.Helper()
	f := setupPasskeys(t)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(f.vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	tf, err := twofactor.New(f.pool, bytes.Repeat([]byte{9}, 32), &recordingJobs{})
	if err != nil {
		t.Fatal(err)
	}
	NewTwoFactor(tf, logger).Register(f.api)
	var cfg config.IdentityConfig
	cfg.RateLimits.SecondFactorPerUser = perUser
	cfg.RateLimits.EmailStartPerEmail = config.RateLimit{Limit: 100, Window: time.Minute}
	var enforcement *SSOEnforcement
	if sso != nil {
		enforcement = NewSSOEnforcement(sso, ssoTestIssuer)
	}
	NewReauth(cfg, ReauthDeps{
		Users:     f.q,
		Sessions:  f.sessions,
		Passkeys:  passkey.NewLogin(f.rp, passkey.NewValkeyChallengeStore(f.vk), f.pool),
		TwoFactor: tf,
		Codes:     emailauth.New(emailauth.NewStore(f.pool), emailauth.Options{}),
		Jobs:      f.jobs,
		Audit:     audit.New(f.pool),
		SSO:       enforcement,
	}, limiter, logger).Register(f.api)
	return &reauthFixture{passkeyFixture: f}
}

var generousLimit = config.RateLimit{Limit: 100, Window: time.Minute}

// staleSignIn creates a user whose session signed in an hour ago and returns
// it with the bearer header and the session's tokens.
func (f *reauthFixture) staleSignIn(t *testing.T, addr string) (db.User, string, session.Tokens) {
	t.Helper()
	verified := time.Now()
	u, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: addr, EmailVerifiedAt: &verified, Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	tok, err := f.sessions.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	return u, "Authorization: Bearer " + tok.AccessToken, tok
}

type reauthOptions struct {
	Methods []string `json:"methods"`
	Passkey *struct {
		ChallengeID string          `json:"challenge_id"`
		Options     json.RawMessage `json:"options"`
	} `json:"passkey"`
	SSOURL        string `json:"sso_url"`
	EmailCodeSent bool   `json:"email_code_sent"`
	RetryAfter    int    `json:"retry_after"`
}

func (f *reauthFixture) reauthOptions(t *testing.T, auth string, body map[string]any) reauthOptions {
	t.Helper()
	args := []any{auth}
	if body != nil {
		args = append(args, body)
	}
	resp := f.api.Post(ReauthPrefix+"/options", args...)
	if resp.Code != http.StatusOK {
		t.Fatalf("options: %d %s", resp.Code, resp.Body)
	}
	var o reauthOptions
	if err := json.Unmarshal(resp.Body.Bytes(), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func (f *reauthFixture) reauthVerify(auth string, body map[string]any) *httptest.ResponseRecorder {
	return f.api.Post(ReauthPrefix+"/verify", auth, "User-Agent: "+chromeMacUA, body)
}

// lastReauthCode returns the code of the latest reauth_code email to addr.
func (f *reauthFixture) lastReauthCode(t *testing.T, addr string) string {
	t.Helper()
	for i := len(f.jobs.jobs) - 1; i >= 0; i-- {
		j := f.jobs.jobs[i]
		if j.Template == email.TemplateReauthCode && j.To == addr {
			return j.Data["code"].(string)
		}
	}
	t.Fatalf("no reauth_code email to %s in %+v", addr, f.jobs.jobs)
	return ""
}

// tokenAuthTime decodes the auth_time claim of an access token.
func tokenAuthTime(t *testing.T, raw string) time.Time {
	t.Helper()
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", raw)
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		AuthTime int64  `json:"auth_time"`
		SID      string `json:"sid"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return time.Unix(c.AuthTime, 0)
}

// expectReauthenticated checks a successful verify: a new access token and
// session row whose authentication time is now, kept by a refresh.
func (f *reauthFixture) expectReauthenticated(t *testing.T, resp *httptest.ResponseRecorder, u db.User, tok session.Tokens, method string) {
	t.Helper()
	if resp.Code != http.StatusOK {
		t.Fatalf("verify: %d %s", resp.Code, resp.Body)
	}
	var out struct {
		AccessToken string    `json:"access_token"`
		ExpiresIn   int       `json:"expires_in"`
		AuthTime    time.Time `json:"auth_time"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.AccessToken == "" || out.ExpiresIn <= 0 || time.Since(out.AuthTime) > time.Minute {
		t.Fatalf("verify = %+v", out)
	}
	if at := tokenAuthTime(t, out.AccessToken); time.Since(at) > time.Minute {
		t.Fatalf("access token auth_time = %v, want now", at)
	}
	// The new token works, and refreshing keeps the new authentication time.
	if r := f.api.Get(MePath, "Authorization: Bearer "+out.AccessToken); r.Code != http.StatusOK {
		t.Fatalf("me with the new token: %d %s", r.Code, r.Body)
	}
	refreshed, err := f.sessions.Refresh(f.ctx, tok.RefreshToken)
	if err != nil {
		t.Fatalf("refresh after reauth: %v", err)
	}
	if at := tokenAuthTime(t, refreshed.AccessToken); time.Since(at) > time.Minute {
		t.Fatalf("refreshed auth_time = %v, want the re-authentication time", at)
	}
	evs := f.events(t, u.ID, audit.SessionReauthenticated)
	if len(evs) == 0 {
		t.Fatal("session.reauthenticated not audited")
	}
	var meta map[string]any
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["method"] != method || meta["session_id"] != tok.Session.ID.String() {
		t.Fatalf("audit metadata = %v", meta)
	}
}

func (f *reauthFixture) failures(t *testing.T, user uuid.UUID) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, ev := range f.events(t, user, audit.SessionReauthFailed) {
		var m map[string]any
		if err := json.Unmarshal(ev.Metadata, &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func TestReauthEmailCodeIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, nil)
	u, auth, tok := f.staleSignIn(t, "reauth-email@example.com")

	if r := f.api.Post(ReauthPrefix + "/options"); r.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", r.Code)
	}
	o := f.reauthOptions(t, auth, nil)
	if !slices.Equal(o.Methods, []string{ReauthEmail}) || o.Passkey != nil || o.EmailCodeSent {
		t.Fatalf("options = %+v", o)
	}

	// The code is emailed once; a second request inside the cooldown sends none.
	o = f.reauthOptions(t, auth, map[string]any{"send_email_code": true})
	if !o.EmailCodeSent || o.RetryAfter != 30 {
		t.Fatalf("send code = %+v", o)
	}
	code := f.lastReauthCode(t, u.Email)
	sent := len(f.jobs.jobs)
	if o := f.reauthOptions(t, auth, map[string]any{"send_email_code": true}); o.EmailCodeSent || o.RetryAfter < 1 || len(f.jobs.jobs) != sent {
		t.Fatalf("resend inside cooldown = %+v", o)
	}

	// Wrong method, missing and wrong code.
	resp := f.reauthVerify(auth, map[string]any{"method": "totp", "code": "123456"})
	expectProblem(t, "totp without 2FA", resp, http.StatusBadRequest, CodeInvalidRequest)
	resp = f.reauthVerify(auth, map[string]any{"method": "email"})
	expectProblem(t, "no code", resp, http.StatusBadRequest, CodeInvalidRequest)
	resp = f.reauthVerify(auth, map[string]any{"method": "email", "code": wrongCode(code)})
	expectProblem(t, "wrong code", resp, http.StatusBadRequest, CodeInvalidCode)
	if got := f.failures(t, u.ID); len(got) != 1 || got[0]["method"] != "email" || got[0]["reason"] != "invalid_code" {
		t.Fatalf("session.reauth_failed = %v", got)
	}

	f.expectReauthenticated(t, f.reauthVerify(auth, map[string]any{"method": "email", "code": code}), u, tok, ReauthEmail)

	// The code works once.
	resp = f.reauthVerify(auth, map[string]any{"method": "email", "code": code})
	expectProblem(t, "used code", resp, http.StatusBadRequest, CodeInvalidCode)
}

func TestReauthEmailCodeLockoutIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, nil)
	u, auth, _ := f.staleSignIn(t, "reauth-lock@example.com")
	f.reauthOptions(t, auth, map[string]any{"send_email_code": true})
	code := f.lastReauthCode(t, u.Email)

	for i := 1; i < emailauth.MaxAttempts; i++ {
		resp := f.reauthVerify(auth, map[string]any{"method": "email", "code": wrongCode(code)})
		expectProblem(t, "wrong code", resp, http.StatusBadRequest, CodeInvalidCode)
	}
	resp := f.reauthVerify(auth, map[string]any{"method": "email", "code": wrongCode(code)})
	expectProblem(t, "last wrong code", resp, http.StatusTooManyRequests, CodeTooManyAttempts)
	// Locked: even the right code is refused until a new one is requested.
	resp = f.reauthVerify(auth, map[string]any{"method": "email", "code": code})
	expectProblem(t, "right code after lockout", resp, http.StatusTooManyRequests, CodeTooManyAttempts)
	if got := f.failures(t, u.ID); len(got) != emailauth.MaxAttempts+1 {
		t.Fatalf("session.reauth_failed = %d events, want %d", len(got), emailauth.MaxAttempts+1)
	}
	if evs := f.events(t, u.ID, audit.SessionReauthenticated); len(evs) != 0 {
		t.Fatal("re-authenticated after lockout")
	}
}

func TestReauthTOTPIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, nil)
	u, auth, tok := f.staleSignIn(t, "reauth-totp@example.com")
	secret := f.enableTOTP(t, u)

	o := f.reauthOptions(t, auth, nil)
	if !slices.Equal(o.Methods, []string{ReauthTOTP}) {
		t.Fatalf("methods = %v", o.Methods)
	}
	// With 2FA on an emailed code alone is not enough.
	r := f.api.Post(ReauthPrefix+"/options", auth, map[string]any{"send_email_code": true})
	expectProblem(t, "email code with 2FA", r, http.StatusBadRequest, CodeInvalidRequest)
	resp := f.reauthVerify(auth, map[string]any{"method": "email", "code": "123456"})
	expectProblem(t, "email with 2FA", resp, http.StatusBadRequest, CodeInvalidRequest)

	resp = f.reauthVerify(auth, map[string]any{"method": "totp", "code": wrongCode(code(t, secret))})
	expectProblem(t, "wrong totp", resp, http.StatusBadRequest, CodeInvalidCode)
	if got := f.failures(t, u.ID); len(got) != 1 || got[0]["method"] != "totp" {
		t.Fatalf("session.reauth_failed = %v", got)
	}
	f.expectReauthenticated(t, f.reauthVerify(auth, map[string]any{"method": "totp", "code": code(t, secret)}), u, tok, ReauthTOTP)
}

// enableTOTP turns two-factor on for u directly in the store and returns
// the secret.
func (f *reauthFixture) enableTOTP(t *testing.T, u db.User) string {
	t.Helper()
	// A fresh session: 2FA setup needs a recent sign-in.
	fresh, err := f.sessions.Create(f.ctx, u, false, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}
	auth := "Authorization: Bearer " + fresh.AccessToken
	resp := f.api.Post(TwoFactorPrefix+"/enable", auth)
	if resp.Code != http.StatusOK {
		t.Fatalf("enable 2fa: %d %s", resp.Code, resp.Body)
	}
	var out struct {
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if resp := f.api.Post(TwoFactorPrefix+"/verify", auth, map[string]any{"code": code(t, out.Secret)}); resp.Code != http.StatusOK {
		t.Fatalf("confirm 2fa: %d %s", resp.Code, resp.Body)
	}
	return out.Secret
}

func TestReauthPasskeyIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, nil)
	u, auth, tok := f.staleSignIn(t, "reauth-passkey@example.com")
	a := f.registerAuthenticator(t, auth)

	o := f.reauthOptions(t, auth, nil)
	if !slices.Equal(o.Methods, []string{ReauthPasskey, ReauthEmail}) || o.Passkey == nil || o.Passkey.ChallengeID == "" {
		t.Fatalf("options = %+v", o)
	}
	if allow := allowCredentials(t, o.Passkey.Options); len(allow) != 1 {
		t.Fatalf("allowCredentials = %d, want the user's one passkey", len(allow))
	}

	// Another account's passkey proves nothing about this one.
	_, otherAuth, _ := f.staleSignIn(t, "reauth-other@example.com")
	other := f.registerAuthenticator(t, otherAuth)
	assertion, err := other.Login(o.Passkey.Options)
	if err != nil {
		t.Fatal(err)
	}
	resp := f.reauthVerify(auth, map[string]any{"method": "passkey", "challenge_id": o.Passkey.ChallengeID, "response": assertion})
	expectProblem(t, "other account's passkey", resp, http.StatusUnauthorized, CodePasskeyFailed)
	// The options allow only the user's own passkeys, so the ceremony itself
	// rejects it (an assertion that got past it would fail as other_account).
	if got := f.failures(t, u.ID); len(got) != 1 || got[0]["method"] != "passkey" || got[0]["reason"] != "verification_failed" {
		t.Fatalf("session.reauth_failed = %v", got)
	}

	// The challenge was spent; a new one with the user's own passkey works.
	o = f.reauthOptions(t, auth, nil)
	assertion, err = a.Login(o.Passkey.Options)
	if err != nil {
		t.Fatal(err)
	}
	resp = f.reauthVerify(auth, map[string]any{"method": "passkey", "challenge_id": o.Passkey.ChallengeID, "response": assertion})
	f.expectReauthenticated(t, resp, u, tok, ReauthPasskey)

	// A replayed challenge fails.
	resp = f.reauthVerify(auth, map[string]any{"method": "passkey", "challenge_id": o.Passkey.ChallengeID, "response": assertion})
	expectProblem(t, "replayed challenge", resp, http.StatusUnauthorized, CodePasskeyFailed)
}

func TestReauthLockoutAfterRepeatedFailuresIntegration(t *testing.T) {
	f := setupReauth(t, config.RateLimit{Limit: 3, Window: time.Minute}, nil)
	u, auth, _ := f.staleSignIn(t, "reauth-limit@example.com")
	secret := f.enableTOTP(t, u)

	for range 3 {
		resp := f.reauthVerify(auth, map[string]any{"method": "totp", "code": wrongCode(code(t, secret))})
		expectProblem(t, "wrong totp", resp, http.StatusBadRequest, CodeInvalidCode)
	}
	// Locked out for the window: even the right code is refused.
	resp := f.reauthVerify(auth, map[string]any{"method": "totp", "code": code(t, secret)})
	expectProblem(t, "locked out", resp, http.StatusTooManyRequests, CodeRateLimited)
	if resp.Header().Get("Retry-After") == "" {
		t.Fatal("lockout must carry Retry-After")
	}
	got := f.failures(t, u.ID)
	if len(got) != 4 || got[0]["reason"] != "rate_limited" {
		t.Fatalf("session.reauth_failed = %v", got)
	}
	if evs := f.events(t, u.ID, audit.SessionReauthenticated); len(evs) != 0 {
		t.Fatal("re-authenticated while locked out")
	}
}

func TestReauthSSOEnforcedIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, fakeSSOLookup{"acme.example.com": {Slug: "acme", Name: "Acme", Enforce: true}})
	_, auth, _ := f.staleSignIn(t, "ada@acme.example.com")

	o := f.reauthOptions(t, auth, map[string]any{"next": "/projects/shop/access"})
	if !slices.Equal(o.Methods, []string{ReauthSSO}) || o.Passkey != nil {
		t.Fatalf("options = %+v", o)
	}
	sso, err := url.Parse(o.SSOURL)
	if err != nil {
		t.Fatal(err)
	}
	q := sso.Query()
	if sso.Path != AuthPrefix+"/sso/acme/start" || q.Get("reauth") != "true" || q.Get("login_hint") != "ada@acme.example.com" || q.Get("next") != "/projects/shop/access" {
		t.Fatalf("sso_url = %s", o.SSOURL)
	}
	r := f.api.Post(ReauthPrefix+"/options", auth, map[string]any{"send_email_code": true})
	expectProblem(t, "email code under SSO", r, http.StatusBadRequest, CodeInvalidRequest)
	resp := f.reauthVerify(auth, map[string]any{"method": "email", "code": "123456"})
	expectProblem(t, "verify under SSO", resp, http.StatusForbidden, CodeSSORequired)
}

func TestReauthEndedSessionIntegration(t *testing.T) {
	f := setupReauth(t, generousLimit, nil)
	u, auth, _ := f.staleSignIn(t, "reauth-ended@example.com")
	f.reauthOptions(t, auth, map[string]any{"send_email_code": true})
	code := f.lastReauthCode(t, u.Email)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	resp := f.reauthVerify(auth, map[string]any{"method": "email", "code": code})
	expectProblem(t, "ended session", resp, http.StatusUnauthorized, CodeSessionExpired)
}
