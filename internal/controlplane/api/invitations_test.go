package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/platform/authn"
)

type fakeInvitations struct {
	err     error
	invites []orgs.Invite
	grants  []orgs.ProjectGrant
	project uuid.UUID
}

func (f *fakeInvitations) Invite(_ context.Context, _ uuid.UUID, _ string, in []orgs.Invite, grants []orgs.ProjectGrant) ([]orgs.InviteResult, error) {
	f.invites, f.grants = in, grants
	return nil, f.err
}

func (f *fakeInvitations) Pending(context.Context, uuid.UUID, string) ([]orgs.Invitation, error) {
	return nil, f.err
}

func (f *fakeInvitations) ProjectPending(_ context.Context, project uuid.UUID) ([]orgs.Invitation, error) {
	f.project = project
	if f.err != nil {
		return nil, f.err
	}
	return []orgs.Invitation{{
		ID: uuid.New(), Email: "new@example.com", Role: "member",
		Projects: []orgs.InvitationProject{{ID: project, Slug: "shop", Name: "Shop", Role: "editor"}},
	}}, nil
}

func (f *fakeInvitations) Resend(context.Context, uuid.UUID, string, uuid.UUID) (orgs.Invitation, error) {
	return orgs.Invitation{}, f.err
}

func (f *fakeInvitations) Revoke(context.Context, uuid.UUID, string, uuid.UUID) error { return f.err }

func newInvitationsAPI(t *testing.T, svc InvitationService, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	return newInvitationsAPIWith(t, svc, nil, user)
}

func newInvitationsAPIWith(t *testing.T, svc InvitationService, guard ProjectAuthorizer, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if user != uuid.Nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	h := NewInvitations(svc, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if guard != nil {
		h.WithAuthorizer(guard)
	}
	h.Register(api)
	return api
}

// fakeProjectAuthorizer answers AuthorizeProject from a map of project slug
// to outcome; a slug that is absent is ErrNoResource.
type fakeProjectAuthorizer struct {
	projects map[string]error
	ids      map[string]uuid.UUID
	asked    []authz.Permission
}

func (f *fakeProjectAuthorizer) AuthorizeProject(_ context.Context, _ authn.Principal, slug string, perm authz.Permission) (authz.Target, error) {
	f.asked = append(f.asked, perm)
	err, ok := f.projects[slug]
	if !ok {
		return authz.Target{}, authz.ErrNoResource
	}
	if err != nil {
		return authz.Target{}, err
	}
	return authz.Target{ProjectID: f.ids[slug]}, nil
}

func TestInvitationProjectGrants(t *testing.T) {
	shop, blog := uuid.New(), uuid.New()
	guard := func() *fakeProjectAuthorizer {
		return &fakeProjectAuthorizer{
			projects: map[string]error{"shop": nil, "blog": nil, "viewonly": authz.ErrForbidden, "down": fmt.Errorf("x: %w", authz.ErrUnavailable)},
			ids:      map[string]uuid.UUID{"shop": shop, "blog": blog},
		}
	}
	body := func(grants ...map[string]any) map[string]any {
		return map[string]any{
			"invites":        []map[string]any{{"email": "a@example.com", "role": "member"}},
			"project_grants": grants,
		}
	}
	grant := func(project, role string) map[string]any { return map[string]any{"project": project, "role": role} }

	// Each project is checked for manage_access and passed on by id.
	svc, g := &fakeInvitations{}, guard()
	api := newInvitationsAPIWith(t, svc, g, uuid.New())
	if resp := api.Post("/api/v1/orgs/acme/invitations", body(grant("shop", "editor"), grant("blog", "viewer"))); resp.Code != http.StatusOK {
		t.Fatalf("grants: %d %s", resp.Code, resp.Body)
	}
	want := []orgs.ProjectGrant{{ProjectID: shop, Role: "editor"}, {ProjectID: blog, Role: "viewer"}}
	if len(svc.grants) != 2 || svc.grants[0] != want[0] || svc.grants[1] != want[1] {
		t.Fatalf("grants = %+v", svc.grants)
	}
	for _, p := range g.asked {
		if p != authz.ProjectManageAccess {
			t.Fatalf("checked %s, want manage_access", p)
		}
	}

	// A project the caller cannot manage, or that does not exist, is
	// forbidden and nothing is created; so is one SpiceDB cannot answer for
	// (fail closed).
	for _, tc := range []struct {
		name   string
		body   map[string]any
		status int
		code   string
	}{
		{"cannot manage", body(grant("shop", "admin"), grant("viewonly", "viewer")), http.StatusForbidden, "forbidden"},
		{"no such project", body(grant("ghost", "viewer")), http.StatusForbidden, "forbidden"},
		{"authz down", body(grant("down", "viewer")), http.StatusServiceUnavailable, "authz_unavailable"},
		{"project twice", body(grant("shop", "viewer"), grant("shop", "admin")), http.StatusBadRequest, "invalid_request"},
	} {
		svc := &fakeInvitations{}
		resp := newInvitationsAPIWith(t, svc, guard(), uuid.New()).Post("/api/v1/orgs/acme/invitations", tc.body)
		var p struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		if resp.Code != tc.status || p.Code != tc.code || svc.invites != nil {
			t.Errorf("%s: %d %s (service called: %v)", tc.name, resp.Code, resp.Body, svc.invites != nil)
		}
	}

	// Without an authorizer, grants fail closed; invitations without any
	// still work.
	svc = &fakeInvitations{}
	api = newInvitationsAPI(t, svc, uuid.New())
	if resp := api.Post("/api/v1/orgs/acme/invitations", body(grant("shop", "viewer"))); resp.Code != http.StatusServiceUnavailable || svc.invites != nil {
		t.Fatalf("no authorizer: %d %s", resp.Code, resp.Body)
	}
	if resp := api.Post("/api/v1/orgs/acme/invitations", body()); resp.Code != http.StatusOK || svc.grants != nil {
		t.Fatalf("no grants: %d %s %v", resp.Code, resp.Body, svc.grants)
	}

	// At most 20 grants; project roles only.
	many := make([]map[string]any, orgs.MaxProjectGrants+1)
	for i := range many {
		many[i] = grant(fmt.Sprintf("p%d", i), "viewer")
	}
	for name, b := range map[string]map[string]any{"too many": body(many...), "org role": body(grant("shop", "member"))} {
		if resp := newInvitationsAPIWith(t, &fakeInvitations{}, guard(), uuid.New()).Post("/api/v1/orgs/acme/invitations", b); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", name, resp.Code, resp.Body)
		}
	}
}

func TestListProjectInvitations(t *testing.T) {
	shop := uuid.New()
	g := &fakeProjectAuthorizer{projects: map[string]error{"shop": nil, "viewonly": authz.ErrForbidden}, ids: map[string]uuid.UUID{"shop": shop}}
	svc := &fakeInvitations{}
	api := newInvitationsAPIWith(t, svc, g, uuid.New())
	resp := api.Get("/api/v1/projects/shop/invitations")
	if resp.Code != http.StatusOK || svc.project != shop {
		t.Fatalf("list: %d %s", resp.Code, resp.Body)
	}
	var got []Invitation
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].ProjectGrants) != 1 || got[0].ProjectGrants[0] != (InvitationProjectGrant{ProjectID: shop.String(), Project: "shop", ProjectName: "Shop", Role: "editor"}) {
		t.Fatalf("invitations = %+v", got)
	}
	if len(g.asked) != 1 || g.asked[0] != authz.ProjectManageAccess {
		t.Fatalf("checked %v, want manage_access", g.asked)
	}
	for slug, status := range map[string]int{"viewonly": http.StatusForbidden, "ghost": http.StatusNotFound} {
		if resp := api.Get("/api/v1/projects/" + slug + "/invitations"); resp.Code != status {
			t.Errorf("%s: %d %s", slug, resp.Code, resp.Body)
		}
	}
	if resp := newInvitationsAPI(t, svc, uuid.New()).Get("/api/v1/projects/shop/invitations"); resp.Code != http.StatusServiceUnavailable {
		t.Errorf("no authorizer: %d %s", resp.Code, resp.Body)
	}
	if resp := newInvitationsAPIWith(t, svc, g, uuid.Nil).Get("/api/v1/projects/shop/invitations"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: %d %s", resp.Code, resp.Body)
	}
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
