package authz_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/authn"
)

// renamedResolver resolves the project "store" by its current slug and by
// "shop", the slug a rename retired.
type renamedResolver struct{ id, org uuid.UUID }

func (r renamedResolver) OrgID(context.Context, string) (uuid.UUID, error) { return r.org, nil }

func (r renamedResolver) Project(ctx context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	id, org, _, err := r.ProjectCanonical(ctx, slug)
	return id, org, err
}

func (r renamedResolver) ProjectCanonical(_ context.Context, slug string) (uuid.UUID, uuid.UUID, string, error) {
	if slug != "store" && slug != "shop" {
		return uuid.Nil, uuid.Nil, "", authz.ErrNoResource
	}
	return r.id, r.org, "store", nil
}

// allowAll grants every permission.
type allowAll struct{}

func (allowAll) Check(context.Context, authz.Object, authz.Permission, authz.Resource) (bool, error) {
	return true, nil
}

// renamedAPI mounts, behind ContentLocation (when location is set), a
// project path operation guarded by RequireProject and a ?project=
// operation authorized by AuthorizeProject in an API middleware the way the
// query role does.
func renamedAPI(t *testing.T, r authz.Resolver, location bool) (humatest.TestAPI, *authz.Target) {
	t.Helper()
	guard := authz.NewGuard(allowAll{}, r, authz.GuardOptions{}, nil)
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		p := authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}
		next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), p)))
	})
	if location {
		api.UseMiddleware(authz.ContentLocation)
	}
	got := &authz.Target{}
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		slug := ctx.Query("project")
		if slug == "" {
			next(ctx)
			return
		}
		p, _ := authn.FromContext(ctx.Context())
		t, err := guard.AuthorizeProject(ctx.Context(), p, slug, authz.ProjectView)
		if err != nil {
			ctx.SetStatus(http.StatusNotFound)
			return
		}
		*got = t
		next(ctx)
	})
	huma.Register(api, huma.Operation{
		OperationID: "project", Method: http.MethodGet, Path: "/projects/{project}/items",
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
	}, func(ctx context.Context, _ *struct{}) (*struct{}, error) {
		*got, _ = authz.TargetFromContext(ctx)
		return nil, nil
	})
	huma.Register(api, huma.Operation{OperationID: "query", Method: http.MethodGet, Path: "/data"},
		func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })
	return api, got
}

// A project named by a retired slug resolves to the project, and the
// response names the current slug in Content-Location, for path (api role)
// and ?project= (query role) resolution alike.
func TestGuardAnnouncesCanonicalSlug(t *testing.T) {
	r := renamedResolver{id: uuid.New(), org: uuid.New()}
	api, got := renamedAPI(t, r, true)
	for _, tc := range []struct{ name, path, location string }{
		{"path, retired slug", "/projects/shop/items", "/projects/store/items"},
		{"path, current slug", "/projects/store/items", ""},
		{"query, retired slug", "/data?project=shop&range=1h", "/data?project=store&range=1h"},
		{"query, current slug", "/data?project=store", ""},
	} {
		*got = authz.Target{}
		resp := api.Get(tc.path)
		if resp.Code >= 300 {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
			continue
		}
		if loc := resp.Header().Get("Content-Location"); loc != tc.location {
			t.Errorf("%s: Content-Location = %q, want %q", tc.name, loc, tc.location)
		}
		if got.ProjectID != r.id || got.ProjectSlug != "store" {
			t.Errorf("%s: target = %+v", tc.name, *got)
		}
	}
	if resp := api.Get("/projects/nope/items"); resp.Code != http.StatusNotFound || resp.Header().Get("Content-Location") != "" {
		t.Errorf("unknown slug: %d %q", resp.Code, resp.Header().Get("Content-Location"))
	}

	// Without the middleware the retired slug still resolves; nothing is
	// announced.
	bare, _ := renamedAPI(t, r, false)
	if resp := bare.Get("/projects/shop/items"); resp.Code >= 300 || resp.Header().Get("Content-Location") != "" {
		t.Errorf("without ContentLocation: %d %q", resp.Code, resp.Header().Get("Content-Location"))
	}
}

// A Resolver that does not report canonical slugs announces nothing and
// leaves Target.ProjectSlug empty.
func TestGuardPlainResolverAnnouncesNothing(t *testing.T) {
	id, org := uuid.New(), uuid.New()
	r := &mapResolver{orgs: map[string]uuid.UUID{}, projects: map[string]project{"shop": {id: id, org: org}}}
	api, got := renamedAPI(t, r, true)
	resp := api.Get("/projects/shop/items")
	if resp.Code >= 300 || resp.Header().Get("Content-Location") != "" || got.ProjectID != id || got.ProjectSlug != "" {
		t.Fatalf("%d %q %+v", resp.Code, resp.Header().Get("Content-Location"), *got)
	}
}

func TestCanonicalLocation(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"/api/v1/projects/shop", "/api/v1/projects/store"},
		{"/api/v1/projects/shop/environments/shop", "/api/v1/projects/store/environments/store"},
		{"/api/v1/projects/shopping", "/api/v1/projects/shopping"},
		{"/api/v1/query/traffic?project=shop&range=24h", "/api/v1/query/traffic?project=store&range=24h"},
		{"/api/v1/projects/shop/apps?q=shop", "/api/v1/projects/store/apps?q=shop"},
	} {
		u, err := url.Parse(tc.in)
		if err != nil {
			t.Fatal(err)
		}
		if got := authz.CanonicalLocation(*u, "shop", "store"); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.in, got, tc.want)
		}
	}
}

// ForgetProject drops a cached lookup: the next request resolves the slug
// again.
func TestGuardForgetProject(t *testing.T) {
	r := &mapResolver{orgs: map[string]uuid.UUID{}, projects: map[string]project{"shop": {id: uuid.New(), org: uuid.New()}}}
	guard := authz.NewGuard(allowAll{}, r, authz.GuardOptions{}, nil)
	p := authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}
	for range 2 {
		if _, err := guard.AuthorizeProject(context.Background(), p, "shop", authz.ProjectView); err != nil {
			t.Fatal(err)
		}
	}
	if n := r.lookups.Load(); n != 1 {
		t.Fatalf("lookups = %d, want 1 (cached)", n)
	}
	guard.ForgetProject("shop")
	if _, err := guard.AuthorizeProject(context.Background(), p, "shop", authz.ProjectView); err != nil {
		t.Fatal(err)
	}
	if n := r.lookups.Load(); n != 2 {
		t.Fatalf("lookups = %d, want 2 after ForgetProject", n)
	}
	var nilGuard *authz.Guard
	nilGuard.ForgetProject("shop") // no panic
}
