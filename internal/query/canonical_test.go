package query

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/authn"
)

// renamedProject resolves the project "store" by its current slug and by
// "shop", a slug a rename retired (as authz.PGResolver does from
// project_slug_history).
type renamedProject struct{ id, org uuid.UUID }

func (r renamedProject) OrgID(context.Context, string) (uuid.UUID, error) { return r.org, nil }

func (r renamedProject) Project(ctx context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	id, org, _, err := r.ProjectCanonical(ctx, slug)
	return id, org, err
}

func (r renamedProject) ProjectCanonical(_ context.Context, slug string) (uuid.UUID, uuid.UUID, string, error) {
	if slug != "store" && slug != "shop" {
		return uuid.Nil, uuid.Nil, "", authz.ErrNoResource
	}
	return r.id, r.org, "store", nil
}

type viewAll struct{}

func (viewAll) Check(context.Context, authz.Object, authz.Permission, authz.Resource) (bool, error) {
	return true, nil
}

// A session naming a project by a retired slug (?project= or {project} in
// the path) reads the renamed project, and the response names the current
// slug in Content-Location.
func TestQueryResolvesRenamedProjectSlug(t *testing.T) {
	r := renamedProject{id: uuid.New(), org: uuid.New()}
	guard := authz.NewGuard(viewAll{}, r, authz.GuardOptions{}, nil)
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		p := authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}
		next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), p)))
	})
	api.UseMiddleware(authz.ContentLocation)
	api.UseMiddleware(AuthMiddleware(api, stubVerifier{scopes: []string{"read"}}, guard))
	handler := func(ctx context.Context, _ *struct{}) (*whoami, error) {
		out := &whoami{}
		if s, err := principalFrom(ctx); err == nil {
			out.Body.Project = s.ProjectID.String()
		} else if t, ok := authz.TargetFromContext(ctx); ok {
			out.Body.Project = t.ProjectID.String()
		}
		return out, nil
	}
	huma.Register(api, huma.Operation{OperationID: "traffic", Method: http.MethodGet, Path: "/query/traffic", Security: security},
		func(ctx context.Context, _ *ProjectInput) (*whoami, error) { return handler(ctx, nil) })
	huma.Register(api, huma.Operation{
		OperationID: "views", Method: http.MethodGet, Path: "/projects/{project}/views", Security: security,
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
	}, handler)

	for _, tc := range []struct{ path, location string }{
		{"/query/traffic?project=shop", "/query/traffic?project=store"},
		{"/query/traffic?project=store", ""},
		{"/projects/shop/views", "/projects/store/views"},
		{"/projects/store/views", ""},
	} {
		resp := api.Get(tc.path)
		if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), r.id.String()) {
			t.Errorf("%s: %d %s", tc.path, resp.Code, resp.Body)
			continue
		}
		if loc := resp.Header().Get("Content-Location"); loc != tc.location {
			t.Errorf("%s: Content-Location = %q, want %q", tc.path, loc, tc.location)
		}
	}
	if resp := api.Get("/query/traffic?project=nope"); resp.Code != http.StatusNotFound {
		t.Errorf("unknown slug: %d", resp.Code)
	}
}
