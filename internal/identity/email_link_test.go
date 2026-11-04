package identity

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
)

// linkToken is shaped like a real link token (43 base64url characters).
const linkToken = "dGhpcy1pcy1hLW1hZ2ljLWxpbmstdG9rZW4tZm9yLXQ"

func (h *emailVerifyHarness) verifyLink(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	resp := h.api.Post(AuthPrefix+"/email/verify-link", body)
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestEmailVerifyLinkReturnsSessionBundle(t *testing.T) {
	h := newEmailVerifyHarness(t)
	status, body := h.verifyLink(t, map[string]any{"token": linkToken, "remember": true})
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if body["access_token"] != "access-token" || body["refresh_token"] != "refresh-token" || body["next"] != "/acme/endpoints" {
		t.Fatalf("body = %v", body)
	}
	user, _ := body["user"].(map[string]any)
	if user["id"] != knownUser.ID.String() {
		t.Fatalf("user = %v (want the user of the email row)", user)
	}
	if !slices.Equal(h.codes.links, []string{linkToken}) || len(h.codes.calls) != 0 {
		t.Fatalf("VerifyLink calls = %v, VerifyCode calls = %v", h.codes.links, h.codes.calls)
	}
	if len(h.sessions.metas) != 1 || !slices.Equal(h.sessions.metas[0].AMR, []string{"email"}) || !h.sessions.remember[0] {
		t.Fatalf("session created with %+v remember=%v", h.sessions.metas, h.sessions.remember)
	}
	if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginSucceeded {
		t.Fatalf("audit = %+v", h.audit.events)
	}
}

func TestEmailVerifyLinkTwoFactorRequired(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.users.totp[knownUser.ID] = true
	status, body := h.verifyLink(t, map[string]any{"token": linkToken})
	if status != http.StatusOK || body["status"] != "2fa_required" || body["pre_auth_token"] != "pre-auth-token" {
		t.Fatalf("got %d %v", status, body)
	}
	if len(h.sessions.metas) != 0 || len(h.preAuth.issued) != 1 || h.preAuth.issued[0].Remember {
		t.Fatalf("sessions = %v, pre-auth = %+v", h.sessions.metas, h.preAuth.issued)
	}
}

func TestEmailVerifyLinkErrors(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		intent emailauth.Intent
		status int
		code   ErrCode
	}{
		{"invalid", emailauth.ErrInvalidLink, emailauth.IntentSignIn, http.StatusUnauthorized, CodeInvalidToken},
		{"expired", emailauth.ErrLinkExpired, emailauth.IntentSignIn, http.StatusBadRequest, CodeCodeExpired},
		{"change_email intent", nil, emailauth.IntentChangeEmail, http.StatusUnauthorized, CodeInvalidToken},
		{"internal", errors.New("db down"), emailauth.IntentSignIn, http.StatusInternalServerError, CodeInternal},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newEmailVerifyHarness(t)
			h.codes.err = c.err
			h.codes.row.Intent = string(c.intent)
			status, body := h.verifyLink(t, map[string]any{"token": linkToken})
			if status != c.status || body["code"] != string(c.code) {
				t.Fatalf("got %d %v, want %d %s", status, body, c.status, c.code)
			}
			if len(h.sessions.metas) != 0 || len(h.preAuth.issued) != 0 {
				t.Fatal("signed in on a failed link")
			}
			raw, _ := json.Marshal(body)
			if strings.Contains(string(raw), linkToken) {
				t.Fatalf("token echoed in problem: %s", raw)
			}
			if c.code == CodeInternal {
				return
			}
			if len(h.audit.events) != 1 || h.audit.events[0].Kind != audit.LoginFailed || h.audit.events[0].Meta["reason"] != string(c.code) {
				t.Fatalf("audit = %+v", h.audit.events)
			}
			if meta, _ := json.Marshal(h.audit.events[0].Meta); strings.Contains(string(meta), linkToken) {
				t.Fatalf("token audited: %s", meta)
			}
		})
	}
}

func TestEmailVerifyLinkRejectsEmptyToken(t *testing.T) {
	h := newEmailVerifyHarness(t)
	if status, body := h.verifyLink(t, map[string]any{"token": ""}); status != http.StatusUnprocessableEntity {
		t.Fatalf("got %d %v", status, body)
	}
	if len(h.codes.links) != 0 {
		t.Fatal("empty token checked")
	}
}

func TestEmailLinkRedirectsToUIWithoutConsuming(t *testing.T) {
	h := newEmailVerifyHarness(t)
	resp := h.api.Get(AuthPrefix + "/email/link?token=" + linkToken + "&email=ada%2Btest%40example.com")
	if resp.Code != http.StatusFound {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	loc, err := url.Parse(resp.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if loc.Scheme != "https" || loc.Host != "app.example.com" || loc.Path != "/verify" {
		t.Fatalf("Location = %s, want https://app.example.com/verify", loc)
	}
	if loc.Query().Get("token") != linkToken || loc.Query().Get("email") != "ada+test@example.com" {
		t.Fatalf("Location query = %v", loc.Query())
	}
	if resp.Header().Get("Cache-Control") != "no-store" || resp.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("headers = %v", resp.Header())
	}
	if len(h.codes.links) != 0 || len(h.audit.events) != 0 {
		t.Fatal("GET link consumed or audited the token")
	}
	if strings.Contains(h.logs.String(), linkToken) {
		t.Fatalf("token logged: %s", h.logs)
	}
}

func TestEmailLinkWithoutEmail(t *testing.T) {
	h := newEmailVerifyHarness(t)
	resp := h.api.Get(AuthPrefix + "/email/link?token=" + linkToken)
	if resp.Code != http.StatusFound || resp.Header().Get("Location") != "https://app.example.com/verify?token="+linkToken {
		t.Fatalf("got %d Location %q", resp.Code, resp.Header().Get("Location"))
	}
	if resp := h.api.Get(AuthPrefix + "/email/link"); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing token: %d", resp.Code)
	}
}

func TestEmailVerifyLinkNeverLogsToken(t *testing.T) {
	h := newEmailVerifyHarness(t)
	h.codes.err = errors.New("lookup failed")
	h.verifyLink(t, map[string]any{"token": linkToken})
	h.codes.err = nil
	h.users.findErr = errors.New("boom")
	h.verifyLink(t, map[string]any{"token": linkToken})
	if h.logs.Len() == 0 {
		t.Fatal("expected error logs")
	}
	if strings.Contains(h.logs.String(), linkToken) {
		t.Fatalf("token logged: %s", h.logs)
	}
}
