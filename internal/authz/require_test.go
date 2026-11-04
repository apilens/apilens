package authz_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/authn"
)

// schemaChecker answers checks the way authz/schema.zed does for
// organization roles.
type schemaChecker struct {
	roles  map[string]map[string]string // org id -> user id -> role
	down   bool
	checks atomic.Int32
}

var orgGrants = map[authz.Permission][]string{
	authz.OrgManage:        {"owner", "admin"},
	authz.OrgManageMembers: {"owner", "admin"},
	authz.OrgInvite:        {"owner", "admin"},
	authz.OrgManageBilling: {"owner"},
	authz.OrgCreateProject: {"owner", "admin", "member"},
	authz.OrgView:          {"owner", "admin", "member", "viewer"},
}

var projectGrants = map[authz.Permission][]string{
	authz.ProjectDelete:     {"owner", "admin"},
	authz.ProjectManageKeys: {"owner", "admin", "member"},
	authz.ProjectEdit:       {"owner", "admin", "member"},
	authz.ProjectView:       {"owner", "admin", "member", "viewer"},
}

func (c *schemaChecker) Check(_ context.Context, subj authz.Object, perm authz.Permission, res authz.Resource) (bool, error) {
	c.checks.Add(1)
	if c.down {
		return false, fmt.Errorf("%w: connection refused", authz.ErrUnavailable)
	}
	role := c.roles[res.Org][subj.ID]
	grants := orgGrants
	if res.Type == authz.TypeProject {
		grants = projectGrants
	}
	return role != "" && slices.Contains(grants[perm], role), nil
}

type project struct{ id, org uuid.UUID }

// mapResolver resolves from fixed maps and counts lookups.
type mapResolver struct {
	orgs     map[string]uuid.UUID
	projects map[string]project
	lookups  atomic.Int32
}

func (r *mapResolver) OrgID(_ context.Context, slug string) (uuid.UUID, error) {
	r.lookups.Add(1)
	id, ok := r.orgs[slug]
	if !ok {
		return uuid.Nil, authz.ErrNoResource
	}
	return id, nil
}

func (r *mapResolver) Project(_ context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	r.lookups.Add(1)
	p, ok := r.projects[slug]
	if !ok {
		return uuid.Nil, uuid.Nil, authz.ErrNoResource
	}
	return p.id, p.org, nil
}

const principalHeader = "X-Test-Principal"

type env struct {
	api      humatest.TestAPI
	checker  *schemaChecker
	resolver *mapResolver
	guard    *authz.Guard
	acme     uuid.UUID
	web      project
	other    project
	users    map[string]uuid.UUID
	reached  atomic.Int32
	target   authz.Target
}

// newEnv mounts guarded org and project routes over a fixture: org acme
// (one user per role plus a stranger) owning project web, and org beta
// owning project other.
func newEnv(t *testing.T, guard func(c authz.Checker, r authz.Resolver) *authz.Guard) *env {
	t.Helper()
	e := &env{
		checker:  &schemaChecker{roles: map[string]map[string]string{}},
		resolver: &mapResolver{orgs: map[string]uuid.UUID{}, projects: map[string]project{}},
		acme:     uuid.New(),
		users:    map[string]uuid.UUID{},
	}
	beta := uuid.New()
	e.web = project{id: uuid.New(), org: e.acme}
	e.other = project{id: uuid.New(), org: beta}
	e.resolver.orgs["acme"], e.resolver.orgs["beta"] = e.acme, beta
	e.resolver.projects["web"], e.resolver.projects["other"] = e.web, e.other
	e.checker.roles[e.acme.String()] = map[string]string{}
	e.checker.roles[beta.String()] = map[string]string{}
	for _, role := range []string{"owner", "admin", "member", "viewer", "stranger"} {
		id := uuid.New()
		e.users[role] = id
		if role != "stranger" {
			e.checker.roles[e.acme.String()][id.String()] = role
		}
	}
	// The stranger owns beta, so it is a real user with grants elsewhere.
	e.checker.roles[beta.String()][e.users["stranger"].String()] = "owner"
	e.guard = guard(e.checker, e.resolver)

	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if p, ok := e.principal(ctx.Header(principalHeader)); ok {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), p))
		}
		next(ctx)
	})
	route := func(path string, mw func(huma.Context, func(huma.Context))) {
		huma.Register(api, huma.Operation{
			OperationID: strings.NewReplacer("/", "-", "{", "", "}", "").Replace(path),
			Method:      http.MethodGet,
			Path:        path,
			Middlewares: huma.Middlewares{mw},
		}, func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			e.reached.Add(1)
			e.target, _ = authz.TargetFromContext(ctx)
			return nil, nil
		})
	}
	for _, perm := range []authz.Permission{authz.OrgView, authz.OrgManage, authz.OrgManageMembers, authz.OrgManageBilling} {
		route("/orgs/{slug}/"+string(perm), e.guard.RequireOrg(api, perm))
	}
	for _, perm := range []authz.Permission{authz.ProjectView, authz.ProjectEdit, authz.ProjectDelete} {
		route("/orgs/{org}/projects/{slug}/"+string(perm), e.guard.RequireProject(api, perm))
		route("/projects/{project}/"+string(perm), e.guard.RequireProject(api, perm))
	}
	e.api = api
	return e
}

func defaultGuard(c authz.Checker, r authz.Resolver) *authz.Guard {
	return authz.NewGuard(c, r, authz.GuardOptions{}, nil)
}

// principal decodes the test principal header: a role name, "key:<project
// slug>" for an API key or "client".
func (e *env) principal(h string) (authn.Principal, bool) {
	switch {
	case h == "":
		return authn.Principal{}, false
	case h == "client":
		return authn.Principal{Kind: authn.KindClient, ClientID: "ci"}, true
	case strings.HasPrefix(h, "key:"):
		p := e.resolver.projects[strings.TrimPrefix(h, "key:")]
		return authn.Principal{Kind: authn.KindAPIKey, KeyID: uuid.New(), ProjectID: p.id, OrgID: p.org}, true
	default:
		return authn.Principal{Kind: authn.KindUser, UserID: e.users[h]}, true
	}
}

func (e *env) get(path, who string) *httptest.ResponseRecorder {
	return e.api.Get(path, principalHeader+": "+who)
}

func problemCode(t *testing.T, resp *httptest.ResponseRecorder) string {
	t.Helper()
	if resp.Code < 400 {
		return ""
	}
	if ct := resp.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("content type = %q", ct)
	}
	var p struct {
		Status int    `json:"status"`
		Code   string `json:"code"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil || p.Status != resp.Code {
		t.Fatalf("problem %s: %v", resp.Body, err)
	}
	return p.Code
}

// Every permission × role, on organizations and projects, through both
// project path shapes.
func TestRequireByRole(t *testing.T) {
	e := newEnv(t, defaultGuard)
	const (
		ok   = http.StatusNoContent
		deny = http.StatusForbidden
		hide = http.StatusNotFound
	)
	type row struct {
		perm                                   authz.Permission
		owner, admin, member, viewer, stranger int
	}
	check := func(t *testing.T, path string, r row) {
		t.Helper()
		for who, want := range map[string]int{"owner": r.owner, "admin": r.admin, "member": r.member, "viewer": r.viewer, "stranger": r.stranger} {
			resp := e.get(path, who)
			if resp.Code != want {
				t.Errorf("%s as %s: %d %s, want %d", path, who, resp.Code, resp.Body, want)
			}
			code := problemCode(t, resp)
			if (want == deny && code != "forbidden") || (want == hide && code != "not_found") {
				t.Errorf("%s as %s: code %q", path, who, code)
			}
		}
	}
	for _, r := range []row{
		{authz.OrgView, ok, ok, ok, ok, hide},
		{authz.OrgManage, ok, ok, deny, deny, hide},
		{authz.OrgManageMembers, ok, ok, deny, deny, hide},
		{authz.OrgManageBilling, ok, deny, deny, deny, hide},
	} {
		check(t, "/orgs/acme/"+string(r.perm), r)
	}
	for _, r := range []row{
		{authz.ProjectView, ok, ok, ok, ok, hide},
		{authz.ProjectEdit, ok, ok, ok, deny, hide},
		{authz.ProjectDelete, ok, ok, deny, deny, hide},
	} {
		check(t, "/orgs/acme/projects/web/"+string(r.perm), r)
		check(t, "/projects/web/"+string(r.perm), r)
	}
}

func TestRequireUnknownSlugIsNotFoundForEveryone(t *testing.T) {
	e := newEnv(t, defaultGuard)
	for _, path := range []string{
		"/orgs/nope/view", "/orgs/nope/manage",
		"/projects/nope/view", "/projects/nope/edit",
		"/orgs/acme/projects/nope/view", "/orgs/nope/projects/web/view",
		// A project under an organization it does not belong to.
		"/orgs/acme/projects/other/view", "/orgs/beta/projects/web/edit",
	} {
		for _, who := range []string{"owner", "admin", "member", "viewer", "stranger", "client", "key:web", "key:other"} {
			if resp := e.get(path, who); resp.Code != http.StatusNotFound || problemCode(t, resp) != "not_found" {
				t.Errorf("%s as %s: %d %s", path, who, resp.Code, resp.Body)
			}
		}
	}
	if e.reached.Load() != 0 {
		t.Fatal("a refused request reached the handler")
	}
}

// A hidden resource answers exactly like a missing one.
func TestRequireHiddenIsIndistinguishable(t *testing.T) {
	e := newEnv(t, defaultGuard)
	hidden, missing := e.get("/orgs/acme/manage", "stranger"), e.get("/orgs/nope/manage", "stranger")
	if hidden.Code != missing.Code || hidden.Body.String() != missing.Body.String() {
		t.Fatalf("hidden %d %s vs missing %d %s", hidden.Code, hidden.Body, missing.Code, missing.Body)
	}
}

func TestRequireAPIKeyOnlyViewsItsProject(t *testing.T) {
	e := newEnv(t, defaultGuard)
	for _, tc := range []struct {
		path, who string
		want      int
	}{
		{"/projects/web/view", "key:web", http.StatusNoContent},
		{"/orgs/acme/projects/web/view", "key:web", http.StatusNoContent},
		{"/projects/web/edit", "key:web", http.StatusForbidden},
		{"/projects/web/delete", "key:web", http.StatusForbidden},
		{"/orgs/acme/view", "key:web", http.StatusForbidden},
		{"/orgs/acme/manage", "key:web", http.StatusForbidden},
		{"/projects/other/view", "key:web", http.StatusNotFound},
		{"/orgs/beta/view", "key:web", http.StatusNotFound},
		{"/orgs/acme/view", "client", http.StatusNotFound},
		{"/projects/web/view", "client", http.StatusNotFound},
	} {
		if resp := e.get(tc.path, tc.who); resp.Code != tc.want {
			t.Errorf("%s as %s: %d %s, want %d", tc.path, tc.who, resp.Code, resp.Body, tc.want)
		}
	}
	if n := e.checker.checks.Load(); n != 0 {
		t.Fatalf("API keys and clients reached SpiceDB %d times", n)
	}
}

func TestRequireUnauthenticated(t *testing.T) {
	e := newEnv(t, defaultGuard)
	if resp := e.get("/orgs/acme/view", ""); resp.Code != http.StatusUnauthorized || problemCode(t, resp) != "unauthenticated" {
		t.Fatalf("%d %s", resp.Code, resp.Body)
	}
}

func TestRequireFailsClosed(t *testing.T) {
	e := newEnv(t, defaultGuard)
	e.checker.down = true
	for _, path := range []string{"/orgs/acme/view", "/orgs/acme/manage", "/projects/web/edit"} {
		resp := e.get(path, "owner")
		if resp.Code != http.StatusServiceUnavailable || problemCode(t, resp) != "authz_unavailable" || resp.Header().Get("Retry-After") != "1" {
			t.Errorf("%s: %d %v %s", path, resp.Code, resp.Header(), resp.Body)
		}
	}
	// Unknown slugs are still 404: the lookup comes first.
	if resp := e.get("/orgs/nope/view", "owner"); resp.Code != http.StatusNotFound {
		t.Errorf("unknown slug while down: %d", resp.Code)
	}
	if e.reached.Load() != 0 {
		t.Fatal("a request reached the handler while SpiceDB was down")
	}
}

func TestRequireNilGuardFailsClosed(t *testing.T) {
	e := newEnv(t, func(authz.Checker, authz.Resolver) *authz.Guard { return nil })
	if resp := e.get("/orgs/acme/view", "owner"); resp.Code != http.StatusServiceUnavailable || problemCode(t, resp) != "authz_unavailable" {
		t.Fatalf("%d %s", resp.Code, resp.Body)
	}
}

func TestRequirePutsTargetInContext(t *testing.T) {
	e := newEnv(t, defaultGuard)
	if resp := e.get("/orgs/acme/projects/web/edit", "member"); resp.Code != http.StatusNoContent {
		t.Fatalf("%d %s", resp.Code, resp.Body)
	}
	if e.target != (authz.Target{OrgID: e.acme, ProjectID: e.web.id}) {
		t.Fatalf("target = %+v", e.target)
	}
	if resp := e.get("/orgs/acme/view", "viewer"); resp.Code != http.StatusNoContent || e.target != (authz.Target{OrgID: e.acme}) {
		t.Fatalf("%d target = %+v", resp.Code, e.target)
	}
}

func TestRequireCachesSlugs(t *testing.T) {
	e := newEnv(t, defaultGuard)
	for range 3 {
		if resp := e.get("/orgs/acme/view", "owner"); resp.Code != http.StatusNoContent {
			t.Fatalf("%d", resp.Code)
		}
	}
	if n := e.resolver.lookups.Load(); n != 1 {
		t.Fatalf("lookups = %d, want 1", n)
	}

	// The slug is re-created as a new organization: the stale cached id is
	// refused, so the guard looks the slug up again and lets the new owner in.
	fresh := uuid.New()
	e.resolver.orgs["acme"] = fresh
	e.checker.roles[fresh.String()] = map[string]string{e.users["stranger"].String(): "owner"}
	if resp := e.get("/orgs/acme/manage", "stranger"); resp.Code != http.StatusNoContent {
		t.Fatalf("after re-create: %d %s", resp.Code, resp.Body)
	}
	if e.target.OrgID != fresh {
		t.Fatalf("target = %+v, want org %s", e.target, fresh)
	}
}

func TestRequireUnknownResourceTypePanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("no panic")
		}
	}()
	_, api := humatest.New(t)
	authz.NewGuard(&schemaChecker{}, &mapResolver{}, authz.GuardOptions{}, nil).Require(api, authz.TypeUser, authz.OrgView)
}

// AuthorizeProject applies Require's rules to a project named outside the
// path (the query role's ?project=).
func TestAuthorizeProject(t *testing.T) {
	e := newEnv(t, defaultGuard)
	ctx := context.Background()
	cases := []struct {
		who, slug string
		perm      authz.Permission
		want      error
	}{
		{"viewer", "web", authz.ProjectView, nil},
		{"viewer", "web", authz.ProjectEdit, authz.ErrForbidden},
		{"stranger", "web", authz.ProjectView, authz.ErrNoResource},
		{"owner", "other", authz.ProjectView, authz.ErrNoResource},
		{"owner", "missing", authz.ProjectView, authz.ErrNoResource},
		{"owner", "", authz.ProjectView, authz.ErrNoResource},
		{"key:web", "web", authz.ProjectView, nil},
		{"key:web", "other", authz.ProjectView, authz.ErrNoResource},
		{"client", "web", authz.ProjectView, authz.ErrNoResource},
	}
	for _, tc := range cases {
		p, _ := e.principal(tc.who)
		got, err := e.guard.AuthorizeProject(ctx, p, tc.slug, tc.perm)
		if (tc.want == nil && err != nil) || (tc.want != nil && !errors.Is(err, tc.want)) {
			t.Errorf("%s on %q %s: err = %v, want %v", tc.who, tc.slug, tc.perm, err, tc.want)
		}
		if tc.want == nil && (got.ProjectID != e.web.id || got.OrgID != e.acme) {
			t.Errorf("%s on %q: target = %+v", tc.who, tc.slug, got)
		}
	}

	e.checker.down = true
	p, _ := e.principal("owner")
	if _, err := e.guard.AuthorizeProject(ctx, p, "web", authz.ProjectView); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("spicedb down: err = %v, want ErrUnavailable", err)
	}
	var nilGuard *authz.Guard
	if _, err := nilGuard.AuthorizeProject(ctx, p, "web", authz.ProjectView); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("nil guard: err = %v, want ErrUnavailable", err)
	}
}
