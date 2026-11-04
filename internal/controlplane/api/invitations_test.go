package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/platform/authn"
)

type fakeInvitations struct {
	err     error
	invites []orgs.Invite
}

func (f *fakeInvitations) Invite(_ context.Context, _ uuid.UUID, _ string, in []orgs.Invite) ([]orgs.InviteResult, error) {
	f.invites = in
	return nil, f.err
}

func (f *fakeInvitations) Pending(context.Context, uuid.UUID, string) ([]orgs.Invitation, error) {
	return nil, f.err
}

func (f *fakeInvitations) Resend(context.Context, uuid.UUID, string, uuid.UUID) (orgs.Invitation, error) {
	return orgs.Invitation{}, f.err
}

func (f *fakeInvitations) Revoke(context.Context, uuid.UUID, string, uuid.UUID) error { return f.err }

func newInvitationsAPI(t *testing.T, svc InvitationService, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if user != uuid.Nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	NewInvitations(svc, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(api)
	return api
}

func TestInvitationErrors(t *testing.T) {
	id := uuid.New().String()
	invites := map[string]any{"invites": []map[string]any{{"email": "a@example.com", "role": "member"}}}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{orgs.ErrNotFound, http.StatusForbidden, "forbidden"},
		{orgs.ErrForbidden, http.StatusForbidden, "forbidden"},
		{orgs.ErrInvitationNotFound, http.StatusGone, "invite_expired"},
		{orgs.ErrInvalid, http.StatusBadRequest, "invalid_request"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	} {
		api := newInvitationsAPI(t, &fakeInvitations{err: tc.err}, uuid.New())
		for name, resp := range map[string]*httptest.ResponseRecorder{
			"create": api.Post("/api/v1/orgs/acme/invitations", invites),
			"list":   api.Get("/api/v1/orgs/acme/invitations"),
			"resend": api.Post("/api/v1/orgs/acme/invitations/"+id+"/resend", map[string]any{}),
			"revoke": api.Delete("/api/v1/orgs/acme/invitations/" + id),
		} {
			var p struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(resp.Body.Bytes(), &p)
			if resp.Code != tc.status || p.Code != tc.code {
				t.Errorf("%s %v: %d %s", name, tc.err, resp.Code, resp.Body)
			}
		}
	}
}

func TestResendCooldownProblem(t *testing.T) {
	api := newInvitationsAPI(t, &fakeInvitations{err: &orgs.ResendCooldownError{RetryAfter: 90*time.Second + time.Millisecond}}, uuid.New())
	resp := api.Post("/api/v1/orgs/acme/invitations/"+uuid.New().String()+"/resend", map[string]any{})
	var p struct {
		Code       string `json:"code"`
		RetryAfter int    `json:"retry_after"`
	}
	_ = json.Unmarshal(resp.Body.Bytes(), &p)
	if resp.Code != http.StatusTooManyRequests || p.Code != "rate_limited" || p.RetryAfter != 91 || resp.Header().Get("Retry-After") != "91" {
		t.Fatalf("cooldown: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
}

func TestInvitationsRequireUser(t *testing.T) {
	api := newInvitationsAPI(t, &fakeInvitations{}, uuid.Nil)
	if resp := api.Get("/api/v1/orgs/acme/invitations"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("list: %d", resp.Code)
	}
}

func TestInvitationValidation(t *testing.T) {
	svc := &fakeInvitations{}
	api := newInvitationsAPI(t, svc, uuid.New())
	many := make([]map[string]any, orgs.MaxInvites+1)
	for i := range many {
		many[i] = map[string]any{"email": "a@example.com", "role": "member"}
	}
	for name, body := range map[string]any{
		"too many":   map[string]any{"invites": many},
		"none":       map[string]any{"invites": []map[string]any{}},
		"owner role": map[string]any{"invites": []map[string]any{{"email": "a@example.com", "role": "owner"}}},
		"bad email":  map[string]any{"invites": []map[string]any{{"email": "not-an-email", "role": "member"}}},
	} {
		if resp := api.Post("/api/v1/orgs/acme/invitations", body); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", name, resp.Code, resp.Body)
		}
	}
	if svc.invites != nil {
		t.Fatalf("service called with %v", svc.invites)
	}
	if resp := api.Delete("/api/v1/orgs/acme/invitations/not-a-uuid"); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad id: %d %s", resp.Code, resp.Body)
	}
}
