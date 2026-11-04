//go:build integration

package identity

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/passkey/passkeytest"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// setupPasskeyLogin serves the registration and sign-in endpoints over real
// Postgres and Valkey, with perIP as identity.rate_limits.passkey_login_per_ip.
func setupPasskeyLogin(t *testing.T, perIP config.RateLimit) *passkeyFixture {
	t.Helper()
	f := setupPasskeys(t)
	limiter, err := ratelimit.New(f.vk, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	var cfg config.IdentityConfig
	cfg.RateLimits.PasskeyLoginPerIP = perIP
	NewPasskeyLogin(cfg, PasskeyLoginDeps{
		Login:    passkey.NewLogin(f.rp, passkey.NewValkeyChallengeStore(f.vk), f.pool),
		Users:    NewPGSignInUsers(f.pool),
		Sessions: f.sessions,
		Audit:    audit.New(f.pool),
	}, limiter, testutil.Logger(t)).Register(f.api)
	return f
}

// registerAuthenticator adds a passkey from a fresh virtual authenticator to the user
// signed in with auth.
func (f *passkeyFixture) registerAuthenticator(t *testing.T, auth string) *passkeytest.Authenticator {
	t.Helper()
	o := f.options(t, auth)
	a := passkeytest.New(passkeyOrigin, onePasswordAAGUID)
	a.BackupEligible, a.BackupState = true, true
	resp, err := a.Register(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.verify(t, auth, o.ChallengeID, resp, ""); r.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", r.Code, r.Body)
	}
	return a
}

type loginOptions struct {
	ChallengeID string          `json:"challenge_id"`
	Options     json.RawMessage `json:"options"`
}

// loginOptions requests sign-in options; body nil sends no body.
func (f *passkeyFixture) loginOptions(t *testing.T, body any) loginOptions {
	t.Helper()
	var r *httptest.ResponseRecorder
	if body == nil {
		r = f.api.Post(PasskeyLoginPrefix + "/options")
	} else {
		r = f.api.Post(PasskeyLoginPrefix+"/options", body)
	}
	if r.Code != http.StatusOK {
		t.Fatalf("login options: status = %d: %s", r.Code, r.Body)
	}
	var o loginOptions
	if err := json.Unmarshal(r.Body.Bytes(), &o); err != nil || o.ChallengeID == "" {
		t.Fatalf("login options: %s (%v)", r.Body, err)
	}
	return o
}

func (f *passkeyFixture) loginVerify(t *testing.T, challengeID string, response json.RawMessage, extra map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"challenge_id": challengeID, "response": response}
	for k, v := range extra {
		body[k] = v
	}
	return f.api.Post(PasskeyLoginPrefix+"/verify", "User-Agent: "+chromeMacUA, body)
}

// login runs a whole sign-in with a and returns the verify response.
func (f *passkeyFixture) login(t *testing.T, a *passkeytest.Authenticator, extra map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	o := f.loginOptions(t, map[string]any{})
	resp, err := a.Login(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	return f.loginVerify(t, o.ChallengeID, resp, extra)
}

func allowCredentials(t *testing.T, options json.RawMessage) []json.RawMessage {
	t.Helper()
	var opts struct {
		PublicKey struct {
			Challenge string            `json:"challenge"`
			RPID      string            `json:"rpId"`
			Allow     []json.RawMessage `json:"allowCredentials"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(options, &opts); err != nil {
		t.Fatal(err)
	}
	if opts.PublicKey.Challenge == "" || opts.PublicKey.RPID != "localhost" {
		t.Fatalf("options = %s", options)
	}
	return opts.PublicKey.Allow
}

func TestPasskeyLoginIntegration(t *testing.T) {
	f := setupPasskeyLogin(t, config.RateLimit{Limit: 1000, Window: time.Minute})
	u, auth := f.signIn(t, "login@example.com")
	authr := f.registerAuthenticator(t, auth)

	// Two-factor is on: a passkey sign-in still bypasses it.
	if _, err := f.q.UpsertPendingTOTP(f.ctx, db.UpsertPendingTOTPParams{UserID: u.ID, SecretEnc: []byte("sealed")}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.q.ConfirmTOTP(f.ctx, u.ID); err != nil {
		t.Fatal(err)
	}

	// Discoverable options: no body at all, or an empty one.
	if allow := allowCredentials(t, f.loginOptions(t, nil).Options); len(allow) != 0 {
		t.Fatalf("allowCredentials without hint = %d", len(allow))
	}
	// The email hint narrows allowCredentials; an unknown address does not
	// change the options.
	if allow := allowCredentials(t, f.loginOptions(t, map[string]any{"email": " Login@Example.com "}).Options); len(allow) != 1 {
		t.Fatalf("allowCredentials with hint = %d, want 1", len(allow))
	}
	if allow := allowCredentials(t, f.loginOptions(t, map[string]any{"email": "nobody@example.com"}).Options); len(allow) != 0 {
		t.Fatalf("allowCredentials for unknown address = %d", len(allow))
	}
	if r := f.api.Post(PasskeyLoginPrefix+"/options", map[string]any{"email": "not-an-email"}); r.Code != http.StatusBadRequest {
		t.Fatalf("bad email hint: %d %s", r.Code, r.Body)
	}

	// Sign in with a hinted challenge: session bundle, next echoed.
	o := f.loginOptions(t, map[string]any{"email": u.Email})
	resp, err := authr.Login(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	r := f.loginVerify(t, o.ChallengeID, resp, map[string]any{"remember": true, "next": "/projects?tab=keys"})
	if r.Code != http.StatusOK {
		t.Fatalf("verify: %d %s", r.Code, r.Body)
	}
	var out SignInResponse
	if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "" || out.AccessToken == "" || out.RefreshToken == "" || out.User == nil || out.User.Email != u.Email || out.Next != "/projects?tab=keys" {
		t.Fatalf("sign-in = %s", r.Body)
	}

	// The session is passkey-authenticated (no totp) and remembered.
	me := f.api.Get(MePath, "Authorization: Bearer "+out.AccessToken)
	var m Me
	if err := json.Unmarshal(me.Body.Bytes(), &m); err != nil || me.Code != http.StatusOK || !slices.Equal(m.AMR, []string{token.AMRPasskey}) {
		t.Fatalf("me = %d %s", me.Code, me.Body)
	}
	sessions, err := f.q.ListActiveSessionsForUser(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, s := range sessions {
		if slices.Equal(s.Amr, []string{token.AMRPasskey}) && s.Remember {
			found = true
		}
	}
	if !found {
		t.Fatalf("no remembered passkey session among %+v", sessions)
	}

	// Usage recorded; audited.
	creds, err := f.q.ListPasskeyCredentialsForUser(f.ctx, u.ID)
	if err != nil || len(creds) != 1 || creds[0].LastUsedAt == nil || !creds[0].BackupState {
		t.Fatalf("credential after sign-in = %+v (%v)", creds, err)
	}
	evs := f.events(t, u.ID, audit.LoginSucceeded)
	if len(evs) != 1 {
		t.Fatalf("login.succeeded events = %d", len(evs))
	}

	// Replayed challenge: the same assertion again fails.
	if r := f.loginVerify(t, o.ChallengeID, resp, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("replayed challenge: %d %s", r.Code, r.Body)
	}

	// A counting authenticator: the counter is stored, and one that goes
	// backwards is rejected as a possible clone.
	authr.SignCount = 5
	if r := f.login(t, authr, nil); r.Code != http.StatusOK {
		t.Fatalf("counter 5: %d %s", r.Code, r.Body)
	}
	c, err := f.q.GetPasskeyCredentialByCredentialID(f.ctx, authr.CredentialID)
	if err != nil || c.SignCount != 5 {
		t.Fatalf("sign count = %d (%v), want 5", c.SignCount, err)
	}
	authr.SignCount = 3
	if r := f.login(t, authr, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("regressed counter: %d %s", r.Code, r.Body)
	}
	if c, _ := f.q.GetPasskeyCredentialByCredentialID(f.ctx, authr.CredentialID); c.SignCount != 5 {
		t.Fatalf("sign count after clone = %d, want 5", c.SignCount)
	}
	failed := f.events(t, u.ID, audit.LoginFailed)
	if len(failed) != 1 {
		t.Fatalf("login.failed events for the user = %d, want 1", len(failed))
	}
	var meta map[string]any
	if err := json.Unmarshal(failed[0].Metadata, &meta); err != nil || meta["reason"] != "sign_count_regressed" || meta["method"] != "passkey" {
		t.Fatalf("login.failed meta = %s (%v)", failed[0].Metadata, err)
	}
}

func TestPasskeyLoginUnknownCredentialIntegration(t *testing.T) {
	f := setupPasskeyLogin(t, config.RateLimit{Limit: 1000, Window: time.Minute})
	u, auth := f.signIn(t, "known@example.com")
	authr := f.registerAuthenticator(t, auth)
	other, _ := f.signIn(t, "other@example.com")

	// A credential that was never registered.
	stranger := passkeytest.New(passkeyOrigin, uuid.Nil)
	stranger.UserHandle = u.ID[:]
	if r := f.login(t, stranger, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyUnknown {
		t.Fatalf("unregistered credential: %d %s", r.Code, r.Body)
	}

	// A registered credential presenting another user's handle.
	authr.UserHandle = other.ID[:]
	if r := f.login(t, authr, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyUnknown {
		t.Fatalf("mismatched user handle: %d %s", r.Code, r.Body)
	}
	authr.UserHandle = u.ID[:]

	// A response from a foreign origin does not verify.
	authr.Origin = "https://evil.example"
	if r := f.login(t, authr, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("foreign origin: %d %s", r.Code, r.Body)
	}
	authr.Origin = passkeyOrigin

	// A registration challenge is not accepted for sign-in.
	ro := f.options(t, auth)
	resp, err := passkeytest.New(passkeyOrigin, uuid.Nil).Register(ro.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.loginVerify(t, ro.ChallengeID, resp, nil); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("registration challenge: %d %s", r.Code, r.Body)
	}

	// Unsafe next and garbage are invalid requests.
	o := f.loginOptions(t, nil)
	if r := f.loginVerify(t, o.ChallengeID, json.RawMessage(`{"id":"x"}`), map[string]any{"next": "//evil.example"}); r.Code != http.StatusBadRequest {
		t.Fatalf("unsafe next: %d %s", r.Code, r.Body)
	}

	// Nothing signed in; the user's account was left alone.
	if evs := f.events(t, u.ID, audit.LoginSucceeded); len(evs) != 0 {
		t.Fatalf("login.succeeded after rejections = %d", len(evs))
	}

	// The legitimate passkey still works.
	if r := f.login(t, authr, nil); r.Code != http.StatusOK {
		t.Fatalf("legitimate sign-in: %d %s", r.Code, r.Body)
	}
}

func TestPasskeyLoginRateLimitedIntegration(t *testing.T) {
	f := setupPasskeyLogin(t, config.RateLimit{Limit: 2, Window: time.Minute})
	for range 2 {
		f.loginOptions(t, nil)
	}
	r := f.api.Post(PasskeyLoginPrefix + "/options")
	if r.Code != http.StatusTooManyRequests || r.Header().Get("Retry-After") == "" {
		t.Fatalf("third options: %d %s", r.Code, r.Body)
	}
	for range 2 {
		if r := f.loginVerify(t, "nope", json.RawMessage(`{}`), nil); r.Code != http.StatusUnauthorized {
			t.Fatalf("verify: %d %s", r.Code, r.Body)
		}
	}
	if r := f.loginVerify(t, "nope", json.RawMessage(`{}`), nil); r.Code != http.StatusTooManyRequests {
		t.Fatalf("third verify: %d %s", r.Code, r.Body)
	}
}
