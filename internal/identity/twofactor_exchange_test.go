package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/twofactor"
)

// fakeRedeemer is an in-memory PreAuthRedeemer.
type fakeRedeemer struct {
	tokens     map[string]*PreAuth
	attemptErr error
	deleteErr  error
}

func (f *fakeRedeemer) Attempt(_ context.Context, raw string, maxAttempts int) (PreAuth, error) {
	if f.attemptErr != nil {
		return PreAuth{}, f.attemptErr
	}
	p, ok := f.tokens[raw]
	if !ok {
		return PreAuth{}, ErrPreAuthNotFound
	}
	if p.Attempts >= maxAttempts {
		delete(f.tokens, raw)
		return PreAuth{}, ErrPreAuthNotFound
	}
	p.Attempts++
	return *p, nil
}

func (f *fakeRedeemer) Delete(_ context.Context, raw string) (bool, error) {
	if f.deleteErr != nil {
		return false, f.deleteErr
	}
	_, ok := f.tokens[raw]
	delete(f.tokens, raw)
	return ok, nil
}

// fakeSecondFactor accepts code "123456" and backup code "abcd-efgh".
type fakeSecondFactor struct {
	user  db.User
	err   error
	calls []twofactor.Proof
}

func (f *fakeSecondFactor) SignIn(_ context.Context, id uuid.UUID, p twofactor.Proof) (db.User, string, error) {
	f.calls = append(f.calls, p)
	switch {
	case f.err != nil:
		return db.User{}, "", f.err
	case id != f.user.ID:
		return db.User{}, "", twofactor.ErrUserNotFound
	case p.Code == "123456":
		return f.user, "totp", nil
	case p.BackupCode == "abcd-efgh":
		return f.user, "backup_code", nil
	}
	return db.User{}, "", twofactor.ErrInvalidCode
}

type exchangeHarness struct {
	api      humatest.TestAPI
	pre      *fakeRedeemer
	factor   *fakeSecondFactor
	users    *fakeSignInUsers
	sessions *fakeSessionCreator
	audit    *fakeAudit
}

func newExchangeHarness(t *testing.T) *exchangeHarness {
	t.Helper()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	h := &exchangeHarness{
		pre: &fakeRedeemer{tokens: map[string]*PreAuth{
			"pre": {UserID: knownUser.ID, AMR: []string{"email"}, Remember: true, Next: "/acme"},
		}},
		factor:   &fakeSecondFactor{user: knownUser},
		users:    &fakeSignInUsers{},
		sessions: &fakeSessionCreator{now: func() time.Time { return now }},
		audit:    &fakeAudit{},
	}
	x := NewTwoFactorExchange(TwoFactorExchangeDeps{
		PreAuth: h.pre, TwoFactor: h.factor, Users: h.users, Sessions: h.sessions, Audit: h.audit,
	}, slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)))
	x.now = func() time.Time { return now }
	_, h.api = humatest.New(t)
	x.Register(h.api)
	return h
}

func (h *exchangeHarness) exchange(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	resp := h.api.Post(TwoFactorPrefix+"/exchange", body)
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestTwoFactorExchangeTOTP(t *testing.T) {
	h := newExchangeHarness(t)
	status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "123456"})
	if status != http.StatusOK || body["access_token"] != "access-token" || body["next"] != "/acme" {
		t.Fatalf("exchange: %d %v", status, body)
	}
	if len(h.sessions.metas) != 1 || !slices.Equal(h.sessions.metas[0].AMR, []string{"email", "totp"}) || !h.sessions.remember[0] {
		t.Fatalf("session = %+v remember %v", h.sessions.metas, h.sessions.remember)
	}
	if len(h.users.touched) != 1 || h.users.touched[0] != knownUser.ID {
		t.Fatalf("touched = %v", h.users.touched)
	}
	if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginSucceeded ||
		h.audit.events[0].Meta["method"] != "email" || h.audit.events[0].Meta["second_factor"] != "totp" {
		t.Fatalf("audit = %+v", h.audit.events)
	}
	// Single use.
	if status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "123456"}); status != http.StatusUnauthorized || body["code"] != string(CodeInvalidToken) {
		t.Fatalf("reuse: %d %v", status, body)
	}
}

func TestTwoFactorExchangeBackupCode(t *testing.T) {
	h := newExchangeHarness(t)
	status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "backup_code": "abcd-efgh"})
	if status != http.StatusOK {
		t.Fatalf("exchange: %d %v", status, body)
	}
	if !slices.Equal(h.sessions.metas[0].AMR, []string{"email", "backup_code"}) {
		t.Fatalf("amr = %v", h.sessions.metas[0].AMR)
	}
	if _, ok := h.audit.events[0].Meta["org_id"]; ok {
		t.Fatalf("non-SSO sign-in audited an org: %v", h.audit.events[0].Meta)
	}
}

func TestTwoFactorExchangeSSORecordsOrg(t *testing.T) {
	h := newExchangeHarness(t)
	org := uuid.New().String()
	h.pre.tokens["pre"].AMR = []string{"sso"}
	h.pre.tokens["pre"].OrgID = org
	if status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "123456"}); status != http.StatusOK {
		t.Fatalf("exchange: %d %v", status, body)
	}
	if m := h.audit.events[0].Meta; m["method"] != "sso" || m["org_id"] != org {
		t.Fatalf("audit meta = %v", m)
	}
}

func TestTwoFactorExchangeProofRequired(t *testing.T) {
	h := newExchangeHarness(t)
	for name, body := range map[string]map[string]any{
		"neither": {"pre_auth_token": "pre"},
		"both":    {"pre_auth_token": "pre", "code": "123456", "backup_code": "abcd-efgh"},
	} {
		if status, out := h.exchange(t, body); status != http.StatusBadRequest || out["code"] != string(CodeInvalidRequest) {
			t.Fatalf("%s: %d %v", name, status, out)
		}
	}
	// No attempt was spent.
	if h.pre.tokens["pre"].Attempts != 0 || len(h.factor.calls) != 0 {
		t.Fatalf("attempts = %d, calls = %v", h.pre.tokens["pre"].Attempts, h.factor.calls)
	}
}

func TestTwoFactorExchangeUnknownToken(t *testing.T) {
	h := newExchangeHarness(t)
	if status, body := h.exchange(t, map[string]any{"pre_auth_token": "nope", "code": "123456"}); status != http.StatusUnauthorized || body["code"] != string(CodeInvalidToken) {
		t.Fatalf("unknown: %d %v", status, body)
	}
}

func TestTwoFactorExchangeAttemptsExhausted(t *testing.T) {
	h := newExchangeHarness(t)
	for i := 1; i < PreAuthMaxAttempts; i++ {
		if status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "000000"}); status != http.StatusBadRequest || body["code"] != string(CodeInvalidCode) {
			t.Fatalf("attempt %d: %d %v", i, status, body)
		}
	}
	if status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "000000"}); status != http.StatusTooManyRequests || body["code"] != string(CodeTooManyAttempts) {
		t.Fatalf("last attempt: %d %v", status, body)
	}
	if _, ok := h.pre.tokens["pre"]; ok {
		t.Fatal("token kept after the last attempt")
	}
	// Even the right code is too late now.
	if status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "123456"}); status != http.StatusUnauthorized || body["code"] != string(CodeInvalidToken) {
		t.Fatalf("after exhaustion: %d %v", status, body)
	}
	if len(h.sessions.metas) != 0 {
		t.Fatalf("sessions = %v", h.sessions.metas)
	}
	fails := 0
	for _, e := range h.audit.events {
		if e.Kind == audit.LoginFailed && *e.User == knownUser.ID {
			fails++
		}
	}
	if fails != PreAuthMaxAttempts {
		t.Fatalf("login.failed events = %d, want %d", fails, PreAuthMaxAttempts)
	}
}

func TestTwoFactorExchangeFailures(t *testing.T) {
	for name, tc := range map[string]struct {
		setup  func(h *exchangeHarness)
		status int
		code   ErrCode
	}{
		"deleted user":   {func(h *exchangeHarness) { h.factor.err = twofactor.ErrUserNotFound }, http.StatusUnauthorized, CodeInvalidToken},
		"2fa turned off": {func(h *exchangeHarness) { h.factor.err = twofactor.ErrNotEnabled }, http.StatusBadRequest, CodeInvalidCode},
		"store down":     {func(h *exchangeHarness) { h.pre.attemptErr = ErrPreAuthUnavailable }, http.StatusInternalServerError, CodeInternal},
		"check fails":    {func(h *exchangeHarness) { h.factor.err = errors.New("boom") }, http.StatusInternalServerError, CodeInternal},
		"delete fails":   {func(h *exchangeHarness) { h.pre.deleteErr = errors.New("boom") }, http.StatusInternalServerError, CodeInternal},
		"session fails":  {func(h *exchangeHarness) { h.sessions.err = errors.New("boom") }, http.StatusInternalServerError, CodeInternal},
	} {
		t.Run(name, func(t *testing.T) {
			h := newExchangeHarness(t)
			tc.setup(h)
			status, body := h.exchange(t, map[string]any{"pre_auth_token": "pre", "code": "123456"})
			if status != tc.status || body["code"] != string(tc.code) {
				t.Fatalf("%d %v, want %d %s", status, body, tc.status, tc.code)
			}
		})
	}
}
