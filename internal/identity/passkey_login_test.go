package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakePasskeyLogin is a PasskeyAuthenticator returning canned results.
type fakePasskeyLogin struct {
	res      passkey.LoginResult
	err      error
	hints    []string
	verified int
}

func (f *fakePasskeyLogin) Options(_ context.Context, email string) (string, *protocol.CredentialAssertion, error) {
	f.hints = append(f.hints, email)
	return "ch_1", &protocol.CredentialAssertion{}, nil
}

func (f *fakePasskeyLogin) Verify(context.Context, string, []byte) (passkey.LoginResult, error) {
	f.verified++
	return f.res, f.err
}

type passkeyLoginHarness struct {
	api      humatest.TestAPI
	login    *fakePasskeyLogin
	users    *fakeSignInUsers
	sessions *fakeSessionCreator
	audit    *fakeAudit
}

func newPasskeyLoginHarness(t *testing.T, cfg config.IdentityConfig) *passkeyLoginHarness {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &passkeyLoginHarness{
		login:    &fakePasskeyLogin{},
		users:    &fakeSignInUsers{},
		sessions: &fakeSessionCreator{now: time.Now},
		audit:    &fakeAudit{},
	}
	_, h.api = humatest.New(t)
	NewPasskeyLogin(cfg, PasskeyLoginDeps{Login: h.login, Users: h.users, Sessions: h.sessions, Audit: h.audit}, limiter, logger).Register(h.api)
	return h
}

func TestPasskeyLoginOptions(t *testing.T) {
	h := newPasskeyLoginHarness(t, config.IdentityConfig{})
	if r := h.api.Post(PasskeyLoginPrefix + "/options"); r.Code != http.StatusOK {
		t.Fatalf("no body: %d %s", r.Code, r.Body)
	}
	r := h.api.Post(PasskeyLoginPrefix+"/options", map[string]any{"email": " Ada@Example.com "})
	if r.Code != http.StatusOK {
		t.Fatalf("hint: %d %s", r.Code, r.Body)
	}
	var out PasskeyLoginOptionsResponse
	if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil || out.ChallengeID != "ch_1" || len(out.Options) == 0 {
		t.Fatalf("body = %s (%v)", r.Body, err)
	}
	if !slices.Equal(h.login.hints, []string{"", "ada@example.com"}) {
		t.Fatalf("hints = %q", h.login.hints)
	}
	if r := h.api.Post(PasskeyLoginPrefix+"/options", map[string]any{"email": "nope"}); r.Code != http.StatusBadRequest {
		t.Fatalf("bad hint: %d %s", r.Code, r.Body)
	}
}

func TestPasskeyLoginVerify(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	cred := db.PasskeyCredential{ID: uuid.New(), UserID: user.ID}
	body := map[string]any{"challenge_id": "ch_1", "response": map[string]any{"id": "x"}, "remember": true, "next": "/projects"}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   ErrCode
		reason string
	}{
		{"ok", nil, http.StatusOK, "", ""},
		{"unknown credential", passkey.ErrUnknownCredential, http.StatusUnauthorized, CodePasskeyUnknown, "unknown_credential"},
		{"cloned", passkey.ErrCloned, http.StatusUnauthorized, CodePasskeyFailed, "sign_count_regressed"},
		{"replayed challenge", passkey.ErrChallengeNotFound, http.StatusUnauthorized, CodePasskeyFailed, "challenge_not_found"},
		{"bad assertion", fmt.Errorf("%w: bad signature", passkey.ErrVerification), http.StatusUnauthorized, CodePasskeyFailed, "verification_failed"},
		{"store down", errors.New("boom"), http.StatusInternalServerError, CodeInternal, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPasskeyLoginHarness(t, config.IdentityConfig{})
			h.login.res, h.login.err = passkey.LoginResult{User: user, Credential: cred}, tc.err
			r := h.api.Post(PasskeyLoginPrefix+"/verify", body)
			if r.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", r.Code, tc.status, r.Body)
			}
			if tc.code != "" {
				var p Problem
				_ = json.Unmarshal(r.Body.Bytes(), &p)
				if p.Code != tc.code {
					t.Fatalf("code = %q, want %q", p.Code, tc.code)
				}
				if len(h.sessions.metas) != 0 {
					t.Fatal("session created for a failed sign-in")
				}
			}
			if tc.reason != "" {
				if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginFailed || h.audit.events[0].Meta["reason"] != tc.reason {
					t.Fatalf("audit = %+v", h.audit.events)
				}
			}
			if tc.err != nil {
				return
			}
			var out SignInResponse
			if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil || out.AccessToken == "" || out.Next != "/projects" || out.Status != "" {
				t.Fatalf("body = %s (%v)", r.Body, err)
			}
			if len(h.sessions.metas) != 1 || !slices.Equal(h.sessions.metas[0].AMR, []string{token.AMRPasskey}) || !h.sessions.remember[0] {
				t.Fatalf("sessions = %+v %v", h.sessions.metas, h.sessions.remember)
			}
			if !slices.Equal(h.users.touched, []uuid.UUID{user.ID}) {
				t.Fatalf("touched = %v", h.users.touched)
			}
			if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginSucceeded || h.audit.events[0].Meta["method"] != "passkey" {
				t.Fatalf("audit = %+v", h.audit.events)
			}
		})
	}
}

func TestPasskeyLoginVerifyRejectsBadInput(t *testing.T) {
	h := newPasskeyLoginHarness(t, config.IdentityConfig{})
	for name, body := range map[string]map[string]any{
		"unsafe next": {"challenge_id": "ch_1", "response": map[string]any{}, "next": "//evil.example"},
		"no response": {"challenge_id": "ch_1", "response": nil},
	} {
		if r := h.api.Post(PasskeyLoginPrefix+"/verify", body); r.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d: %s", name, r.Code, r.Body)
		}
	}
	if h.login.verified != 0 {
		t.Fatalf("verified %d times", h.login.verified)
	}
}

func TestPasskeyLoginIsRateLimitedPerIP(t *testing.T) {
	// With a limit configured and no Valkey the limiter fails closed: the 503
	// proves the per-IP limit guards both operations. The 429 path is covered
	// by the integration test.
	var cfg config.IdentityConfig
	cfg.RateLimits.PasskeyLoginPerIP = config.RateLimit{Limit: 5, Window: time.Minute}
	h := newPasskeyLoginHarness(t, cfg)
	if r := h.api.Post(PasskeyLoginPrefix + "/options"); r.Code != http.StatusServiceUnavailable {
		t.Fatalf("options: status = %d, want 503", r.Code)
	}
	if r := h.api.Post(PasskeyLoginPrefix+"/verify", map[string]any{"challenge_id": "c", "response": map[string]any{}}); r.Code != http.StatusServiceUnavailable {
		t.Fatalf("verify: status = %d, want 503", r.Code)
	}
	if len(h.login.hints) != 0 || h.login.verified != 0 {
		t.Fatal("limited request reached the ceremony")
	}
}

func TestPasskeyLoginOperationsArePublic(t *testing.T) {
	h := newPasskeyLoginHarness(t, config.IdentityConfig{})
	for _, p := range []string{"/options", "/verify"} {
		op := h.api.OpenAPI().Paths[PasskeyLoginPrefix+p].Post
		if op == nil {
			t.Fatalf("POST %s not registered", p)
		}
		if len(op.Security) != 0 {
			t.Errorf("%s: security = %v, want none (public)", p, op.Security)
		}
		if op.RequestBody != nil && p == "/options" && op.RequestBody.Required {
			t.Errorf("options body is required, want optional")
		}
	}
}
