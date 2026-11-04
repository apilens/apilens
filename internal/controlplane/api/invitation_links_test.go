package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

type fakeInvitationLinks struct {
	err      error
	preview  orgs.InvitationPreview
	accepted orgs.AcceptedInvitation
	user     uuid.UUID
	token    string
}

func (f *fakeInvitationLinks) Lookup(_ context.Context, token string) (orgs.InvitationPreview, error) {
	f.token = token
	return f.preview, f.err
}

func (f *fakeInvitationLinks) Accept(_ context.Context, user uuid.UUID, token string) (orgs.AcceptedInvitation, error) {
	f.user, f.token = user, token
	return f.accepted, f.err
}

func newInvitationLinksAPI(t *testing.T, svc InvitationLinkService, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if user != uuid.Nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	NewInvitationLinks(svc, nil, ratelimit.Rate{}, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(api)
	return api
}

func TestInvitationLookupResponse(t *testing.T) {
	expires := time.Date(2026, 11, 11, 10, 0, 0, 0, time.FixedZone("x", 3600))
	svc := &fakeInvitationLinks{preview: orgs.InvitationPreview{
		OrgName: "Acme", OrgSlug: "acme", InviterName: "Ada", EmailMasked: "b***@example.com", Role: "member", ExpiresAt: expires,
	}}
	// Public: no user.
	resp := newInvitationLinksAPI(t, svc, uuid.Nil).Get("/api/v1/auth/invitations/tok-123")
	if resp.Code != http.StatusOK {
		t.Fatalf("lookup: %d %s", resp.Code, resp.Body)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	org, _ := got["org"].(map[string]any)
	if svc.token != "tok-123" || org["name"] != "Acme" || org["slug"] != "acme" || got["inviter_name"] != "Ada" ||
		got["email_masked"] != "b***@example.com" || got["role"] != "member" || got["expires_at"] != "2026-11-11T09:00:00Z" {
		t.Fatalf("lookup = %s", resp.Body)
	}
	if _, ok := got["email"]; ok {
		t.Fatalf("lookup leaks the email: %s", resp.Body)
	}
}

func TestAcceptInvitationResponse(t *testing.T) {
	user := uuid.New()
	org := orgs.Org{ID: uuid.New(), Slug: "acme", Name: "Acme", Role: "viewer", CreatedAt: time.Now()}
	svc := &fakeInvitationLinks{accepted: orgs.AcceptedInvitation{Org: org, Joined: true}}
	resp := newInvitationLinksAPI(t, svc, user).Post("/api/v1/auth/invitations/tok-123/accept", map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", resp.Code, resp.Body)
	}
	var got AcceptedInvitation
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if svc.user != user || svc.token != "tok-123" || !got.Joined || got.Org.ID != org.ID.String() || got.Org.Role != "viewer" || got.Org.Slug != "acme" {
		t.Fatalf("accept = %s", resp.Body)
	}
}

func TestAcceptInvitationRequiresUser(t *testing.T) {
	svc := &fakeInvitationLinks{}
	resp := newInvitationLinksAPI(t, svc, uuid.Nil).Post("/api/v1/auth/invitations/tok/accept", map[string]any{})
	if resp.Code != http.StatusUnauthorized || svc.token != "" {
		t.Fatalf("accept: %d %s", resp.Code, resp.Body)
	}
}

func TestInvitationLinkErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{orgs.ErrInvitationTokenInvalid, http.StatusUnauthorized, "invalid_token"},
		{orgs.ErrInvitationExpired, http.StatusGone, "invite_expired"},
		{orgs.ErrInviteEmailMismatch, http.StatusForbidden, "invite_email_mismatch"},
		{orgs.ErrUserGone, http.StatusUnauthorized, "session_expired"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	} {
		api := newInvitationLinksAPI(t, &fakeInvitationLinks{err: tc.err}, uuid.New())
		for name, resp := range map[string]*httptest.ResponseRecorder{
			"lookup": api.Get("/api/v1/auth/invitations/tok"),
			"accept": api.Post("/api/v1/auth/invitations/tok/accept", map[string]any{}),
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

func TestInvitationLinkTokenTooLong(t *testing.T) {
	svc := &fakeInvitationLinks{}
	resp := newInvitationLinksAPI(t, svc, uuid.Nil).Get("/api/v1/auth/invitations/" + strings.Repeat("a", orgs.MaxInvitationTokenLen+1))
	if resp.Code != http.StatusUnprocessableEntity || svc.token != "" {
		t.Fatalf("long token: %d %s", resp.Code, resp.Body)
	}
}
