package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeCodes answers VerifyCode and VerifyLink with row or err.
type fakeCodes struct {
	row   db.AuthEmailToken
	err   error
	calls []string
	links []string
}

func (f *fakeCodes) VerifyLink(_ context.Context, token string) (db.AuthEmailToken, error) {
	f.links = append(f.links, token)
	return f.row, f.err
}

func (f *fakeCodes) VerifyCode(_ context.Context, addr, code string) (db.AuthEmailToken, error) {
	f.calls = append(f.calls, addr+"|"+code)
	return f.row, f.err
}

// fakeSignInUsers is an in-memory SignInUsers.
type fakeSignInUsers struct {
	byEmail  map[string]db.User
	totp     map[uuid.UUID]bool
	touched  []uuid.UUID
	findErr  error
	totpErr  error
	touchErr error
}

func (f *fakeSignInUsers) FindOrCreateVerified(_ context.Context, addr string) (db.User, bool, error) {
	if f.findErr != nil {
		return db.User{}, false, f.findErr
	}
	now := time.Now()
	if u, ok := f.byEmail[addr]; ok {
		u.EmailVerifiedAt = &now
		f.byEmail[addr] = u
		return u, false, nil
	}
	u := db.User{ID: uuid.New(), Email: addr, EmailVerifiedAt: &now}
	f.byEmail[addr] = u
	return u, true, nil
}

func (f *fakeSignInUsers) TOTPConfirmed(_ context.Context, id uuid.UUID) (bool, error) {
	return f.totp[id], f.totpErr
}

func (f *fakeSignInUsers) TouchLastLogin(_ context.Context, id uuid.UUID) error {
	f.touched = append(f.touched, id)
	return f.touchErr
}

// fakeSessionCreator records Create calls.
type fakeSessionCreator struct {
	remember []bool
	metas    []session.Meta
	err      error
	now      func() time.Time
}

func (f *fakeSessionCreator) Create(_ context.Context, user db.User, remember bool, meta session.Meta) (session.Tokens, error) {
	if f.err != nil {
		return session.Tokens{}, f.err
	}
	f.remember = append(f.remember, remember)
	f.metas = append(f.metas, meta)
	return session.Tokens{
		AccessToken:     "access-token",
		AccessExpiresAt: f.now().Add(15 * time.Minute),
		RefreshToken:    "refresh-token",
		Session:         db.Session{ID: uuid.New(), UserID: user.ID, Remember: remember, Amr: meta.AMR},
		User:            user,
	}, nil
}

// fakePreAuth records issued challenges.
type fakePreAuth struct {
	issued []PreAuth
	ttls   []time.Duration
	err    error
}

func (f *fakePreAuth) Issue(_ context.Context, p PreAuth, ttl time.Duration) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.issued = append(f.issued, p)
	f.ttls = append(f.ttls, ttl)
	return "pre-auth-token", nil
}

type emailVerifyHarness struct {
	api      humatest.TestAPI
	codes    *fakeCodes
	users    *fakeSignInUsers
	sessions *fakeSessionCreator
	preAuth  *fakePreAuth
	audit    *fakeAudit
	logs     *bytes.Buffer
}

func newEmailVerifyHarness(t *testing.T) *emailVerifyHarness {
	t.Helper()
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	limiter, err := ratelimit.New(nil, logger, nil) // zero rates: limits disabled
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	next := "/acme/endpoints"
	h := &emailVerifyHarness{
		codes:    &fakeCodes{row: db.AuthEmailToken{ID: uuid.New(), Email: "ada@example.com", Intent: "signin", NextPath: &next}},
		users:    &fakeSignInUsers{byEmail: map[string]db.User{"ada@example.com": knownUser}, totp: map[uuid.UUID]bool{}},
		sessions: &fakeSessionCreator{now: func() time.Time { return now }},
		preAuth:  &fakePreAuth{},
		audit:    &fakeAudit{},
		logs:     logs,
	}
	cfg := config.IdentityConfig{PreAuthTTL: 3 * time.Minute, PublicUIURL: "https://app.example.com/"}
	e := NewEmailVerify(cfg, EmailVerifyDeps{
		Codes: h.codes, Users: h.users, Sessions: h.sessions, PreAuth: h.preAuth, Audit: h.audit,
	}, limiter, logger)
	e.now = func() time.Time { return now }
	_, h.api = humatest.New(t)
	e.Register(h.api)
	return h
}

func (h *emailVerifyHarness) verify(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	resp := h.api.Post(AuthPrefix+"/email/verify", body)
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestEmailVerifyReturnsSessionBundle(t *testing.T) {
	h := newEmailVerifyHarness(t)
	status, body := h.verify(t, map[string]any{"email": " Ada@Example.com ", "code": "123 456", "remember": true})
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if body["access_token"] != "access-token" || body["refresh_token"] != "refresh-token" ||
		body["expires_in"] != float64(900) || body["next"] != "/acme/endpoints" {
		t.Fatalf("body = %v", body)
	}
	if _, ok := body["status"]; ok {
		t.Fatalf("session bundle has status: %v", body)
	}
	user, _ := body["user"].(map[string]any)
	if user["id"] != knownUser.ID.String() || user["email_verified"] != true {
		t.Fatalf("user = %v", user)
	}
	if got := h.codes.calls; len(got) != 1 || got[0] != "ada@example.com|123 456" {
		t.Fatalf("VerifyCode calls = %v (want the normalized address)", got)
	}
	if len(h.sessions.metas) != 1 || !slices.Equal(h.sessions.metas[0].AMR, []string{"email"}) || !h.sessions.remember[0] {
		t.Fatalf("session created with %+v remember=%v, want amr [email], remember", h.sessions.metas, h.sessions.remember)
	}
	if len(h.users.touched) != 1 || h.users.touched[0] != knownUser.ID {
		t.Fatalf("touched = %v", h.users.touched)
	}
	if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginSucceeded || *h.audit.events[0].User != knownUser.ID {
		t.Fatalf("audit = %+v", h.audit.events)
	}
	if strings.Contains(h.logs.String(), "refresh-token") || strings.Contains(h.logs.String(), "access-token") {
		t.Fatalf("tokens logged: %s", h.logs)
	}
}

func TestEmailVerifyRememberOff(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.codes.row.NextPath = nil
	status, body := h.verify(t, map[string]any{"email": "new@example.com", "code": "123456"})
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if len(h.sessions.remember) != 1 || h.sessions.remember[0] {
		t.Fatalf("remember = %v, want false", h.sessions.remember)
	}
	if body["next"] != users.OnboardingPath {
		t.Fatalf("new user without a stored next: next = %v, want %s", body["next"], users.OnboardingPath)
	}
	if _, ok := h.users.byEmail["new@example.com"]; !ok {
		t.Fatal("new user not created")
	}
}

func TestEmailVerifyNextForNewAndReturningUsers(t *testing.T) {
	t.Run("returning user without next", func(t *testing.T) {
		h := newEmailVerifyHarness(t)
		h.codes.row.NextPath = nil
		status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "123456"})
		if status != http.StatusOK {
			t.Fatalf("status = %d: %v", status, body)
		}
		if _, ok := body["next"]; ok {
			t.Fatalf("next present for a returning user without one stored: %v", body)
		}
	})
	t.Run("new user keeps the requested next", func(t *testing.T) {
		h := newEmailVerifyHarness(t)
		status, body := h.verify(t, map[string]any{"email": "new@example.com", "code": "123456"})
		if status != http.StatusOK {
			t.Fatalf("status = %d: %v", status, body)
		}
		if body["next"] != "/acme/endpoints" {
			t.Fatalf("next = %v, want the stored /acme/endpoints", body["next"])
		}
	})
}

func TestEmailVerifyTwoFactorRequired(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.users.totp[knownUser.ID] = true
	status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "123456", "remember": true})
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if body["status"] != "2fa_required" || body["pre_auth_token"] != "pre-auth-token" || body["next"] != "/acme/endpoints" {
		t.Fatalf("body = %v", body)
	}
	for _, k := range []string{"access_token", "refresh_token", "user", "expires_in"} {
		if _, ok := body[k]; ok {
			t.Fatalf("2fa answer has %s: %v", k, body)
		}
	}
	if len(h.sessions.metas) != 0 {
		t.Fatal("session created before the second factor")
	}
	want := PreAuth{UserID: knownUser.ID, AMR: []string{"email"}, Remember: true, Next: "/acme/endpoints"}
	if len(h.preAuth.issued) != 1 || h.preAuth.issued[0].UserID != want.UserID || !slices.Equal(h.preAuth.issued[0].AMR, want.AMR) ||
		h.preAuth.issued[0].Remember != want.Remember || h.preAuth.issued[0].Next != want.Next || h.preAuth.ttls[0] != 3*time.Minute {
		t.Fatalf("pre-auth = %+v ttl %v, want %+v ttl 3m", h.preAuth.issued, h.preAuth.ttls, want)
	}
	if len(h.users.touched) != 0 {
		t.Fatal("last login touched before the second factor")
	}
}

func TestEmailVerifyCodeErrors(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   ErrCode
	}{
		{emailauth.ErrInvalidCode, http.StatusBadRequest, CodeInvalidCode},
		{emailauth.ErrCodeExpired, http.StatusBadRequest, CodeCodeExpired},
		{emailauth.ErrTooManyAttempts, http.StatusTooManyRequests, CodeTooManyAttempts},
		{errors.New("db down"), http.StatusInternalServerError, CodeInternal},
	}
	for _, c := range cases {
		t.Run(string(c.code), func(t *testing.T) {
			h := newEmailVerifyHarness(t)
			h.codes.err = c.err
			status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "000000"})
			if status != c.status || body["code"] != string(c.code) {
				t.Fatalf("got %d %v, want %d %s", status, body, c.status, c.code)
			}
			if len(h.sessions.metas) != 0 || len(h.preAuth.issued) != 0 {
				t.Fatal("signed in on a failed code")
			}
			if c.code == CodeInternal {
				if strings.Contains(body["detail"].(string), "db down") {
					t.Fatalf("internal error leaked: %v", body)
				}
				return
			}
			if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginFailed || h.audit.events[0].Meta["reason"] != string(c.code) {
				t.Fatalf("audit = %+v", h.audit.events)
			}
		})
	}
}

func TestEmailVerifyRejectsNonSignInIntent(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.codes.row.Intent = string(emailauth.IntentChangeEmail)
	status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "123456"})
	if status != http.StatusBadRequest || body["code"] != string(CodeInvalidCode) {
		t.Fatalf("got %d %v", status, body)
	}
	if len(h.sessions.metas) != 0 {
		t.Fatal("signed in with a change_email code")
	}
}

func TestEmailVerifyRejectsMalformedEmail(t *testing.T) {
	h := newEmailVerifyHarness(t)
	status, body := h.verify(t, map[string]any{"email": "ada@localhost", "code": "123456"})
	if status != http.StatusBadRequest || body["code"] != string(CodeInvalidRequest) {
		t.Fatalf("got %d %v", status, body)
	}
	if len(h.codes.calls) != 0 {
		t.Fatal("code checked for a malformed address")
	}
}

func TestEmailVerifyInternalFailures(t *testing.T) {
	for name, set := range map[string]func(h *emailVerifyHarness){
		"find user": func(h *emailVerifyHarness) { h.users.findErr = errors.New("boom") },
		"totp":      func(h *emailVerifyHarness) { h.users.totpErr = errors.New("boom") },
		"session":   func(h *emailVerifyHarness) { h.sessions.err = errors.New("boom") },
		"pre-auth": func(h *emailVerifyHarness) {
			h.users.totp[knownUser.ID] = true
			h.preAuth.err = errors.New("boom")
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newEmailVerifyHarness(t)
			set(h)
			status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "123456"})
			if status != http.StatusInternalServerError || body["code"] != string(CodeInternal) {
				t.Fatalf("got %d %v", status, body)
			}
		})
	}
}

func TestEmailVerifyBookkeepingFailuresStillSignIn(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.users.touchErr = errors.New("boom")
	h.audit.err = errors.New("boom")
	if status, body := h.verify(t, map[string]any{"email": "ada@example.com", "code": "123456"}); status != http.StatusOK {
		t.Fatalf("got %d %v", status, body)
	}
}
