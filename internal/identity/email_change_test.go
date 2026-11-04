package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/emailchange"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// fakeEmailChange is an EmailChangeService returning canned results.
type fakeEmailChange struct {
	pending  emailchange.Pending
	user     db.User
	err      error
	ids      []uuid.UUID
	sessions []uuid.UUID
	args     []string
}

func (f *fakeEmailChange) Start(_ context.Context, id uuid.UUID, newEmail string) (emailchange.Pending, error) {
	f.ids = append(f.ids, id)
	f.args = append(f.args, newEmail)
	return f.pending, f.err
}

func (f *fakeEmailChange) Confirm(_ context.Context, id, sess uuid.UUID, code string) (db.User, error) {
	f.ids = append(f.ids, id)
	f.sessions = append(f.sessions, sess)
	f.args = append(f.args, code)
	return f.user, f.err
}

func newTestEmailChange(t *testing.T, svc EmailChangeService, p *authn.Principal) (humatest.TestAPI, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if p != nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p))
		}
		next(ctx)
	})
	NewEmailChange(svc, slog.New(slog.NewJSONHandler(logs, nil))).Register(api)
	return api, logs
}

func TestEmailChangeStart(t *testing.T) {
	p := testPrincipal()
	expires := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	svc := &fakeEmailChange{pending: emailchange.Pending{Email: "new@example.com", ExpiresAt: expires}}
	api, _ := newTestEmailChange(t, svc, p)

	resp := api.Post(EmailChangePath, map[string]any{"new_email": "new@example.com"})
	if resp.Code != http.StatusAccepted {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var m map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &m); err != nil ||
		m["pending_email"] != "new@example.com" || m["expires_at"] != "2026-11-04T10:00:00Z" {
		t.Fatalf("body = %s (%v)", resp.Body, err)
	}
	if len(svc.ids) != 1 || svc.ids[0] != p.UserID || svc.args[0] != "new@example.com" {
		t.Fatalf("service called with %v %v", svc.ids, svc.args)
	}
}

func TestEmailChangeConfirm(t *testing.T) {
	p := testPrincipal()
	svc := &fakeEmailChange{user: db.User{ID: p.UserID, Email: "new@example.com", Preferences: []byte(`{}`), Onboarding: []byte(`{}`)}}
	api, _ := newTestEmailChange(t, svc, p)

	resp := api.Post(EmailConfirmPath, map[string]any{"code": "123 456"})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var m Me
	if err := json.Unmarshal(resp.Body.Bytes(), &m); err != nil || m.Email != "new@example.com" {
		t.Fatalf("me = %+v (%v)", m, err)
	}
	if svc.ids[0] != p.UserID || svc.sessions[0] != p.SessionID || svc.args[0] != "123 456" {
		t.Fatalf("service called with %v %v %v", svc.ids, svc.sessions, svc.args)
	}
}

func TestEmailChangeErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		path   string
		status int
		code   ErrCode
	}{
		{emailchange.ErrEmailTaken, EmailChangePath, http.StatusConflict, CodeEmailTaken},
		{emailchange.ErrSameEmail, EmailChangePath, http.StatusBadRequest, CodeInvalidRequest},
		{emailchange.ErrNotFound, EmailChangePath, http.StatusUnauthorized, CodeSessionExpired},
		{errors.New("boom"), EmailChangePath, http.StatusInternalServerError, CodeInternal},
		{emailauth.ErrInvalidCode, EmailConfirmPath, http.StatusBadRequest, CodeInvalidCode},
		{emailauth.ErrCodeExpired, EmailConfirmPath, http.StatusBadRequest, CodeCodeExpired},
		{emailauth.ErrTooManyAttempts, EmailConfirmPath, http.StatusTooManyRequests, CodeTooManyAttempts},
		{emailchange.ErrEmailTaken, EmailConfirmPath, http.StatusConflict, CodeEmailTaken},
		{emailchange.ErrNotFound, EmailConfirmPath, http.StatusUnauthorized, CodeSessionExpired},
	} {
		api, logs := newTestEmailChange(t, &fakeEmailChange{err: tc.err}, testPrincipal())
		body := map[string]any{"new_email": "new@example.com"}
		if tc.path == EmailConfirmPath {
			body = map[string]any{"code": "123456"}
		}
		resp := api.Post(tc.path, body)
		var prob Problem
		_ = json.Unmarshal(resp.Body.Bytes(), &prob)
		if resp.Code != tc.status || prob.Code != tc.code {
			t.Errorf("%s %v: status = %d, code = %s", tc.path, tc.err, resp.Code, prob.Code)
		}
		if tc.code == CodeInternal && !bytes.Contains(logs.Bytes(), []byte("boom")) {
			t.Errorf("internal error not logged: %s", logs)
		}
	}
}

func TestEmailChangeUnauthenticated(t *testing.T) {
	svc := &fakeEmailChange{}
	api, _ := newTestEmailChange(t, svc, nil)
	for path, body := range map[string]map[string]any{
		EmailChangePath:  {"new_email": "new@example.com"},
		EmailConfirmPath: {"code": "123456"},
	} {
		if resp := api.Post(path, body); resp.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d", path, resp.Code)
		}
	}
	if len(svc.ids) != 0 {
		t.Fatalf("service called without a principal")
	}
}
