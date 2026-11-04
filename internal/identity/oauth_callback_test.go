package identity

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeOAuthUsers is an in-memory OAuthUsers keyed by (provider, subject),
// then by email.
type fakeOAuthUsers struct {
	mu      sync.Mutex
	linked  map[string]uuid.UUID
	byEmail map[string]db.User
	totp    map[uuid.UUID]bool
	seen    []ExternalIdentity
	touched []uuid.UUID
	err     error
}

func newFakeOAuthUsers() *fakeOAuthUsers {
	return &fakeOAuthUsers{linked: map[string]uuid.UUID{}, byEmail: map[string]db.User{}, totp: map[uuid.UUID]bool{}}
}

func (f *fakeOAuthUsers) FindOrCreateOAuth(_ context.Context, ext ExternalIdentity) (db.User, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = append(f.seen, ext)
	if f.err != nil {
		return db.User{}, false, f.err
	}
	key := ext.Provider + ":" + ext.Subject
	if id, ok := f.linked[key]; ok {
		for _, u := range f.byEmail {
			if u.ID == id {
				return u, false, nil
			}
		}
	}
	u, ok := f.byEmail[ext.Email]
	if !ok {
		u = db.User{ID: uuid.New(), Email: ext.Email}
		f.byEmail[ext.Email] = u
	}
	f.linked[key] = u.ID
	return u, !ok, nil
}

func (f *fakeOAuthUsers) TOTPConfirmed(_ context.Context, id uuid.UUID) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.totp[id], nil
}

func (f *fakeOAuthUsers) TouchLastLogin(_ context.Context, id uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, id)
	return nil
}

// memHandoff is an in-memory HandoffStore.
type memHandoff struct {
	mu   sync.Mutex
	m    map[string]SignInResponse
	ttls []time.Duration
	n    int
	err  error
}

func (h *memHandoff) Issue(_ context.Context, res SignInResponse, ttl time.Duration) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.err != nil {
		return "", h.err
	}
	h.n++
	code := fmt.Sprintf("handoff-%d", h.n)
	h.m[code] = res
	h.ttls = append(h.ttls, ttl)
	return code, nil
}

func (h *memHandoff) Take(_ context.Context, code string) (SignInResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	res, ok := h.m[code]
	if !ok {
		return SignInResponse{}, ErrHandoffNotFound
	}
	delete(h.m, code)
	return res, nil
}

type callbackHarness struct {
	api      humatest.TestAPI
	o        *OAuth
	idp      *fakeIdP
	users    *fakeOAuthUsers
	sessions *fakeSessionCreator
	preAuth  *fakePreAuth
	handoff  *memHandoff
	audit    *fakeAudit
	logs     *bytes.Buffer
}

const testUIURL = "https://app.example.com"

func newCallbackHarness(t *testing.T) *callbackHarness {
	t.Helper()
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	cfg := testOAuthCfg
	cfg.PublicUIURL = testUIURL + "/"
	cfg.PreAuthTTL = 3 * time.Minute
	h := &callbackHarness{
		idp:      newFakeIdP(t),
		users:    newFakeOAuthUsers(),
		sessions: &fakeSessionCreator{now: func() time.Time { return now }},
		preAuth:  &fakePreAuth{},
		handoff:  &memHandoff{m: map[string]SignInResponse{}},
		audit:    &fakeAudit{},
		logs:     logs,
	}
	h.o = NewOAuth(cfg, newMemStates(), limiter, logger).WithSignIn(OAuthSignInDeps{
		Users: h.users, Sessions: h.sessions, PreAuth: h.preAuth, Handoff: h.handoff, Audit: h.audit,
	})
	h.o.now = func() time.Time { return now }
	h.idp.Use(h.o)
	_, h.api = humatest.New(t)
	h.o.Register(h.api)
	return h
}

// googleGrant is a valid Google grant for flow f.
func googleGrant(f startedFlow, sub, email string) idpGrant {
	return idpGrant{challenge: f.challenge, claims: map[string]any{
		"sub": sub, "nonce": f.nonce, "email": email, "email_verified": true, "name": "Ada", "picture": "https://example.com/ada.png",
	}}
}

// githubGrant is a valid GitHub grant for flow f.
func githubGrant(f startedFlow, id int64, emails ...githubEmail) idpGrant {
	return idpGrant{challenge: f.challenge, ghUser: githubUser{ID: id, Login: "ada", Name: "Ada"}, ghEmails: emails}
}

// callback runs GET …/callback and returns the redirect target.
func (h *callbackHarness) callback(t *testing.T, provider string, q url.Values) *url.URL {
	t.Helper()
	resp := h.api.Get(callbackPath(provider, q))
	if resp.Code != http.StatusFound {
		t.Fatalf("callback status = %d: %s", resp.Code, resp.Body)
	}
	if resp.Header().Get("Cache-Control") != "no-store" || resp.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("headers = %v", resp.Header())
	}
	u, err := url.Parse(resp.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// handedOff checks loc is the UI callback and redeems its code.
func (h *callbackHarness) handedOff(t *testing.T, loc *url.URL) SignInResponse {
	t.Helper()
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != testUIURL+"/auth/callback" {
		t.Fatalf("redirect = %s, want the UI callback", loc)
	}
	if len(loc.Query()) != 1 {
		t.Fatalf("redirect carries more than the code: %s", loc)
	}
	res, err := h.handoff.Take(context.Background(), loc.Query().Get("code"))
	if err != nil {
		t.Fatalf("handoff code %q: %v", loc.Query().Get("code"), err)
	}
	return res
}

// wantSignInError checks loc is the sign-in page with ?error=code.
func wantSignInError(t *testing.T, loc *url.URL, code string) {
	t.Helper()
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != testUIURL+"/sign-in" || loc.Query().Get("error") != code || len(loc.Query()) != 1 {
		t.Fatalf("redirect = %s, want /sign-in?error=%s", loc, code)
	}
}

func (h *callbackHarness) lastEvent(t *testing.T) audit.Event {
	t.Helper()
	if len(h.audit.events) == 0 {
		t.Fatal("no audit event")
	}
	return h.audit.events[len(h.audit.events)-1]
}

func TestOAuthCallbackGoogleNewUser(t *testing.T) {
	h := newCallbackHarness(t)
	f := beginOAuth(t, h.api, "google", "remember=true")
	h.idp.Grant("g-code", googleGrant(f, "google-sub-1", "Ada@Example.com"))

	res := h.handedOff(t, h.callback(t, "google", url.Values{"code": {"g-code"}, "state": {f.state}}))
	if res.AccessToken != "access-token" || res.RefreshToken != "refresh-token" || res.ExpiresIn != 900 || res.Status != "" {
		t.Fatalf("handoff = %+v", res)
	}
	if res.User == nil || res.User.Email != "ada@example.com" || res.Next != users.OnboardingPath {
		t.Fatalf("handoff user/next = %+v / %q", res.User, res.Next)
	}
	if h.handoff.ttls[0] != HandoffTTL || HandoffTTL != time.Minute {
		t.Errorf("handoff ttl = %v", h.handoff.ttls[0])
	}
	want := ExternalIdentity{Provider: "google", Subject: "google-sub-1", Email: "ada@example.com"}
	if len(h.users.seen) != 1 || h.users.seen[0].Provider != want.Provider || h.users.seen[0].Subject != want.Subject || h.users.seen[0].Email != want.Email {
		t.Fatalf("identity = %+v, want %+v", h.users.seen, want)
	}
	if h.users.seen[0].Profile["name"] != "Ada" {
		t.Errorf("profile = %v", h.users.seen[0].Profile)
	}
	if !slices.Equal(h.sessions.metas[0].AMR, []string{"google"}) || !h.sessions.remember[0] {
		t.Fatalf("session amr = %v remember = %v", h.sessions.metas[0].AMR, h.sessions.remember)
	}
	ev := h.lastEvent(t)
	if ev.Kind != audit.LoginSucceeded || ev.Meta["method"] != "google" || !slices.Equal(ev.Meta["amr"].([]string), []string{"google"}) {
		t.Fatalf("audit = %+v", ev)
	}
	if len(h.users.touched) != 1 {
		t.Errorf("last login touched %d times", len(h.users.touched))
	}
	// Tokens never reach a log line.
	if strings.Contains(h.logs.String(), "access-token") || strings.Contains(h.logs.String(), "refresh-token") {
		t.Fatalf("tokens logged: %s", h.logs)
	}
}

func TestOAuthCallbackGitHubReturningUser(t *testing.T) {
	h := newCallbackHarness(t)
	existing := db.User{ID: uuid.New(), Email: "ada@example.com"}
	h.users.byEmail["ada@example.com"] = existing

	f := beginOAuth(t, h.api, "github", "next=/acme/endpoints")
	h.idp.Grant("gh-code", githubGrant(f, 4242,
		githubEmail{Email: "other@example.com", Verified: true},
		githubEmail{Email: "ADA@example.com", Primary: true, Verified: true},
	))
	res := h.handedOff(t, h.callback(t, "github", url.Values{"code": {"gh-code"}, "state": {f.state}}))
	if res.AccessToken == "" || res.User == nil || res.User.ID != existing.ID.String() || res.Next != "/acme/endpoints" {
		t.Fatalf("handoff = %+v", res)
	}
	ext := h.users.seen[0]
	if ext.Provider != "github" || ext.Subject != "4242" || ext.Email != "ada@example.com" || ext.Profile["login"] != "ada" {
		t.Fatalf("identity = %+v", ext)
	}
	if !slices.Equal(h.sessions.metas[0].AMR, []string{"github"}) || h.sessions.remember[0] {
		t.Fatalf("session amr = %v remember = %v", h.sessions.metas[0].AMR, h.sessions.remember)
	}
	ev := h.lastEvent(t)
	if ev.Kind != audit.LoginSucceeded || *ev.User != existing.ID || !slices.Equal(ev.Meta["amr"].([]string), []string{"github"}) {
		t.Fatalf("audit = %+v", ev)
	}
}

func TestOAuthCallbackTwoFactorRequired(t *testing.T) {
	h := newCallbackHarness(t)
	u := db.User{ID: uuid.New(), Email: "mfa@example.com"}
	h.users.byEmail[u.Email] = u
	h.users.totp[u.ID] = true

	f := beginOAuth(t, h.api, "github", "next=/acme&remember=true")
	h.idp.Grant("c", githubGrant(f, 7, githubEmail{Email: "mfa@example.com", Primary: true, Verified: true}))
	res := h.handedOff(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}))
	if res.Status != TwoFactorRequiredStatus || res.PreAuthToken != "pre-auth-token" || res.AccessToken != "" || res.Next != "/acme" {
		t.Fatalf("handoff = %+v", res)
	}
	if len(h.sessions.metas) != 0 {
		t.Fatal("session created before the second factor")
	}
	pre := h.preAuth.issued[0]
	if pre.UserID != u.ID || !slices.Equal(pre.AMR, []string{"github"}) || !pre.Remember || pre.Next != "/acme" || h.preAuth.ttls[0] != 3*time.Minute {
		t.Fatalf("pre-auth = %+v ttl %v", pre, h.preAuth.ttls[0])
	}
}

func TestOAuthCallbackStateMismatch(t *testing.T) {
	t.Run("missing state", func(t *testing.T) {
		h := newCallbackHarness(t)
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}}), "oauth_state_mismatch")
		if h.lastEvent(t).Kind != audit.LoginFailed {
			t.Fatal("want login.failed audited")
		}
	})

	t.Run("unknown state", func(t *testing.T) {
		h := newCallbackHarness(t)
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {"forged"}}), "oauth_state_mismatch")
		if h.idp.calls() != 0 {
			t.Fatal("code exchanged for an unknown state")
		}
	})

	t.Run("state is single use", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c1", githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true}))
		h.handedOff(t, h.callback(t, "github", url.Values{"code": {"c1"}, "state": {f.state}}))
		h.idp.Grant("c2", githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c2"}, "state": {f.state}}), "oauth_state_mismatch")
	})

	t.Run("state of another provider", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
	})

	t.Run("wrong PKCE verifier", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		g := githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true})
		g.challenge = s256("another verifier")
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
		if len(h.users.seen) != 0 {
			t.Fatal("user resolved without a token")
		}
	})

	t.Run("wrong nonce", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "google", "")
		g := googleGrant(f, "s", "a@example.com")
		g.claims["nonce"] = "replayed"
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
		if len(h.users.seen) != 0 {
			t.Fatal("user resolved from an id_token with the wrong nonce")
		}
	})

	t.Run("id_token for another client", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "google", "")
		g := googleGrant(f, "s", "a@example.com")
		g.claims["aud"] = "someone-else"
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
	})

	t.Run("expired id_token", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "google", "")
		g := googleGrant(f, "s", "a@example.com")
		g.claims["exp"] = time.Now().Add(-time.Hour).Unix()
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
	})
}

func TestOAuthCallbackUnverifiedEmail(t *testing.T) {
	t.Run("google email_verified false", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "google", "")
		g := googleGrant(f, "s", "a@example.com")
		g.claims["email_verified"] = false
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_email_unverified")
		if len(h.users.seen) != 0 {
			t.Fatal("user resolved from an unverified email")
		}
		ev := h.lastEvent(t)
		if ev.Kind != audit.LoginFailed || ev.Meta["method"] != "google" || ev.Meta["code"] != "oauth_email_unverified" {
			t.Fatalf("audit = %+v", ev)
		}
	})

	t.Run("google without email", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "google", "")
		g := googleGrant(f, "s", "")
		delete(g.claims, "email")
		delete(g.claims, "email_verified")
		h.idp.Grant("c", g)
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_email_unverified")
	})

	t.Run("github primary not verified", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c", githubGrant(f, 9,
			githubEmail{Email: "primary@example.com", Primary: true},
			githubEmail{Email: "verified@example.com", Verified: true},
		))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_email_unverified")
		if len(h.users.seen) != 0 {
			t.Fatal("user resolved without a primary verified email")
		}
	})

	t.Run("github no emails", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c", githubGrant(f, 9))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_email_unverified")
	})
}

func TestOAuthCallbackDeniedConsent(t *testing.T) {
	h := newCallbackHarness(t)
	f := beginOAuth(t, h.api, "google", "")
	loc := h.callback(t, "google", url.Values{"error": {"access_denied"}, "error_description": {"The user denied"}, "state": {f.state}})
	wantSignInError(t, loc, CodeOAuthDenied)
	if h.idp.calls() != 0 || len(h.users.seen) != 0 {
		t.Fatal("denied consent reached the token endpoint or the users")
	}
	ev := h.lastEvent(t)
	if ev.Kind != audit.LoginFailed || ev.Meta["reason"] != "access_denied" {
		t.Fatalf("audit = %+v", ev)
	}
	// The state is burned: a later callback with it cannot succeed.
	h.idp.Grant("c", googleGrant(f, "s", "a@example.com"))
	wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), "oauth_state_mismatch")
}

func TestOAuthCallbackFailures(t *testing.T) {
	t.Run("deleted account", func(t *testing.T) {
		h := newCallbackHarness(t)
		h.users.err = ErrOAuthAccountDeleting
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c", githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "account_deleting")
	})

	t.Run("user store failure", func(t *testing.T) {
		h := newCallbackHarness(t)
		h.users.err = errors.New("db down")
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c", githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "internal_error")
	})

	t.Run("handoff store unavailable", func(t *testing.T) {
		h := newCallbackHarness(t)
		h.handoff.err = ErrHandoffUnavailable
		f := beginOAuth(t, h.api, "github", "")
		h.idp.Grant("c", githubGrant(f, 1, githubEmail{Email: "a@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), "internal_error")
	})

	t.Run("missing code", func(t *testing.T) {
		h := newCallbackHarness(t)
		f := beginOAuth(t, h.api, "github", "")
		wantSignInError(t, h.callback(t, "github", url.Values{"state": {f.state}}), "invalid_request")
	})

	t.Run("disabled provider is 404", func(t *testing.T) {
		cfg := testOAuthCfg
		cfg.OAuth.GitHub = config.OAuthProviderConfig{}
		api, _ := newTestOAuth(t, cfg, newMemStates(), nil)
		if resp := api.Get(callbackPath("github", url.Values{"code": {"c"}, "state": {"s"}})); resp.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.Code)
		}
	})
}

func TestOAuthCallbackOperation(t *testing.T) {
	_, api := humatest.New(t)
	NewOAuth(config.IdentityConfig{}, newMemStates(), nil, nil).Register(api)
	op := api.OpenAPI().Paths[AuthPrefix+"/oauth/{provider}/callback"].Get
	if op == nil {
		t.Fatal("GET /auth/oauth/{provider}/callback not registered")
	}
	if len(op.Security) != 0 {
		t.Errorf("security = %v, want none (public)", op.Security)
	}
	if _, ok := op.Responses["302"]; !ok {
		t.Errorf("responses = %v, want 302", keys(op.Responses))
	}
}
