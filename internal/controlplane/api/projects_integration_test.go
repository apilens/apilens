//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// setupProjects is setupOrgs with the project endpoints mounted too.
func setupProjects(t *testing.T) *orgsFixture {
	t.Helper()
	f := setupOrgs(t, ratelimit.Rate{})
	NewProjects(projects.New(f.pool), nil, ratelimit.Rate{}, testutil.Logger(t)).Register(f.api)
	return f
}

func (f *orgsFixture) createProject(user uuid.UUID, org, name, slug string, envs ...string) *httptest.ResponseRecorder {
	body := map[string]any{"name": name, "slug": slug}
	if envs != nil {
		body["environments"] = envs
	}
	return f.api.Post(OrgsPath+"/"+org+"/projects", as(user), body)
}

func (f *orgsFixture) mustCreateProject(t *testing.T, user uuid.UUID, org, name, slug string, envs ...string) Project {
	t.Helper()
	resp := f.createProject(user, org, name, slug, envs...)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create project %s: %d %s", slug, resp.Code, resp.Body)
	}
	return decode[Project](t, resp)
}

func TestCreateProject(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "p-owner@example.com")
	member := f.user(t, "p-member@example.com")
	viewer := f.user(t, "p-viewer@example.com")
	stranger := f.user(t, "p-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")

	resp := f.createProject(member, "acme", "  Checkout API ", "checkout", "staging", "production", "staging")
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	p := decode[Project](t, resp)
	if p.Slug != "checkout" || p.Name != "Checkout API" || p.OrgID != org.ID || p.OrgSlug != "acme" || p.Role != "member" ||
		!slices.Equal(p.Environments, []string{"production", "staging"}) || p.CreatedAt.IsZero() {
		t.Fatalf("project = %+v", p)
	}
	if n := f.count(t, `SELECT count(*) FROM environments WHERE project_id = $1`, p.ID); n != 2 {
		t.Fatalf("environments = %d, want 2", n)
	}

	var aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT aggregate_id, payload FROM outbox WHERE topic = 'project.created'`).Scan(&aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if aggregate != p.ID || payload["project_id"] != p.ID || payload["org_id"] != org.ID {
		t.Fatalf("outbox = %s %v", aggregate, payload)
	}

	// Environments default to production.
	if d := f.mustCreateProject(t, owner, "acme", "Web", "web"); !slices.Equal(d.Environments, []string{"production"}) || d.Role != "owner" {
		t.Fatalf("default environments = %+v", d)
	}

	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		org    string
		slug   string
		envs   []string
		status int
		code   string
	}{
		{"viewer", viewer, "acme", "viewer-proj", nil, http.StatusForbidden, "forbidden"},
		{"stranger", stranger, "acme", "stranger-proj", nil, http.StatusForbidden, "forbidden"},
		{"missing org", owner, "missing", "nowhere", nil, http.StatusForbidden, "forbidden"},
		{"reserved slug", owner, "acme", "slug-available", nil, http.StatusConflict, "slug_taken"},
		{"bad environment", owner, "acme", "bad-env", []string{"prod env"}, http.StatusBadRequest, "invalid_request"},
	} {
		resp := f.createProject(tc.user, tc.org, "X", tc.slug, tc.envs...)
		if p := decode[problem](t, resp); resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM projects`); n != 2 {
		t.Fatalf("projects = %d, want 2", n)
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'project.created'`); n != 2 {
		t.Fatalf("project.created rows = %d, want 2", n)
	}
}

func TestCreateProjectGlobalSlugConflict(t *testing.T) {
	f := setupProjects(t)
	alice := f.user(t, "alice@example.com")
	bob := f.user(t, "bob@example.com")
	f.mustCreate(t, alice, "Alice Co", "alice-co")
	f.mustCreate(t, bob, "Bob Co", "bob-co")
	f.mustCreateProject(t, alice, "alice-co", "Shop", "shop")
	f.mustCreateProject(t, alice, "alice-co", "Shop 2", "shop-2")

	// Another organization cannot reuse the slug: project slugs are global.
	resp := f.createProject(bob, "bob-co", "Shop", "shop")
	if resp.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	p := decode[problem](t, resp)
	if p.Code != "slug_taken" || len(p.Suggestions) == 0 || len(p.Suggestions) > orgs.MaxSuggestions || p.Suggestions[0] != "shop-3" {
		t.Fatalf("problem = %+v", p)
	}
	for _, s := range p.Suggestions {
		if n := f.count(t, `SELECT count(*) FROM projects WHERE slug = $1 AND deleted_at IS NULL`, s); n != 0 || !orgs.ValidSlug(s) {
			t.Fatalf("suggestion %q is unusable", s)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'project.created'`); n != 2 {
		t.Fatalf("project.created rows = %d, want 2", n)
	}

	// Concurrent creates of one slug end with exactly one winner.
	var wg sync.WaitGroup
	codes := make([]int, 6)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = f.createProject(bob, "bob-co", "Race", "race").Code
		}()
	}
	wg.Wait()
	slices.Sort(codes)
	if codes[0] != http.StatusCreated || codes[1] != http.StatusConflict || codes[len(codes)-1] != http.StatusConflict {
		t.Fatalf("race codes = %v", codes)
	}
}

func TestProjectSlugAvailable(t *testing.T) {
	f := setupProjects(t)
	u := f.user(t, "avail@example.com")
	f.mustCreate(t, u, "Acme", "acme")
	f.mustCreateProject(t, u, "acme", "Web", "web")

	get := func(slug string) projectAvailability {
		resp := f.api.Get(ProjectSlugAvailablePath+"?slug="+slug, as(u))
		if resp.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", slug, resp.Code, resp.Body)
		}
		return decode[projectAvailability](t, resp)
	}
	// An organization slug does not make a project slug unavailable.
	if a := get("acme"); !a.Available || a.Suggestions == nil || len(a.Suggestions) != 0 {
		t.Fatalf("acme = %+v", a)
	}
	if a := get("web"); a.Available || len(a.Suggestions) == 0 || a.Suggestions[0] != "web-2" {
		t.Fatalf("web = %+v", a)
	}
	if a := get("slug-available"); a.Available || len(a.Suggestions) == 0 {
		t.Fatalf("reserved = %+v", a)
	}
	if resp := f.api.Get(ProjectSlugAvailablePath + "?slug=web"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", resp.Code)
	}
}

type projectAvailability struct {
	Available   bool     `json:"available"`
	Suggestions []string `json:"suggestions"`
}

func TestListAndGetProjects(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "lg-owner@example.com")
	viewer := f.user(t, "lg-viewer@example.com")
	stranger := f.user(t, "lg-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreate(t, stranger, "Other", "other")
	f.join(t, "acme", viewer, "viewer")
	f.mustCreateProject(t, owner, "acme", "Zeta", "zeta", "production", "dev")
	alpha := f.mustCreateProject(t, owner, "acme", "Alpha", "alpha")
	f.mustCreateProject(t, stranger, "other", "Elsewhere", "elsewhere")

	resp := f.api.Get(OrgsPath+"/acme/projects", as(viewer))
	if resp.Code != http.StatusOK {
		t.Fatalf("list: %d %s", resp.Code, resp.Body)
	}
	list := decode[[]Project](t, resp)
	if len(list) != 2 || list[0].Slug != "alpha" || list[1].Slug != "zeta" || list[0].Role != "viewer" ||
		!slices.Equal(list[1].Environments, []string{"dev", "production"}) || !slices.Equal(list[0].Environments, []string{"production"}) {
		t.Fatalf("list = %+v", list)
	}

	got := decode[Project](t, f.api.Get(ProjectsPath+"/alpha", as(viewer)))
	if got.ID != alpha.ID || got.OrgSlug != "acme" || got.Role != "viewer" || got.Name != "Alpha" {
		t.Fatalf("get = %+v", got)
	}

	// Strangers cannot tell an existing project or org from a missing one.
	a, b := f.api.Get(ProjectsPath+"/alpha", as(stranger)), f.api.Get(ProjectsPath+"/missing", as(stranger))
	if a.Code != http.StatusForbidden || decode[problem](t, a).Code != "forbidden" || a.Body.String() != b.Body.String() {
		t.Fatalf("stranger get: %d %s / %d %s", a.Code, a.Body, b.Code, b.Body)
	}
	a, b = f.api.Get(OrgsPath+"/acme/projects", as(stranger)), f.api.Get(OrgsPath+"/missing/projects", as(stranger))
	if a.Code != http.StatusForbidden || a.Body.String() != b.Body.String() {
		t.Fatalf("stranger list: %d %s / %d %s", a.Code, a.Body, b.Code, b.Body)
	}

	nobody := f.user(t, "lg-empty@example.com")
	f.mustCreate(t, nobody, "Empty", "empty")
	if resp := f.api.Get(OrgsPath+"/empty/projects", as(nobody)); resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != "[]" {
		t.Fatalf("empty list: %d %s", resp.Code, resp.Body)
	}
}

func TestUpdateProject(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "up-owner@example.com")
	member := f.user(t, "up-member@example.com")
	viewer := f.user(t, "up-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	f.mustCreateProject(t, owner, "acme", "Web", "web")
	patch := func(u uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
		return f.api.Patch(ProjectsPath+"/web", as(u), body)
	}

	resp := patch(member, map[string]any{"name": "  Web App ", "slug": "web"})
	if p := decode[Project](t, resp); resp.Code != http.StatusOK || p.Name != "Web App" || p.Slug != "web" || p.Role != "member" || len(p.Environments) != 1 {
		t.Fatalf("member patch: %d %s", resp.Code, resp.Body)
	}
	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		body   map[string]any
		status int
		code   string
	}{
		{"viewer", viewer, map[string]any{"name": "Nope"}, http.StatusForbidden, "forbidden"},
		{"slug change", owner, map[string]any{"slug": "web-new"}, http.StatusConflict, "slug_immutable"},
		{"blank name", owner, map[string]any{"name": "  "}, http.StatusBadRequest, "invalid_request"},
	} {
		resp := patch(tc.user, tc.body)
		if p := decode[problem](t, resp); resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if got := decode[Project](t, f.api.Get(ProjectsPath+"/web", as(viewer))); got.Name != "Web App" {
		t.Fatalf("persisted = %+v", got)
	}
}

func TestProjectEnvironments(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "env-owner@example.com")
	viewer := f.user(t, "env-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	f.mustCreateProject(t, owner, "acme", "Web", "web")
	envs := ProjectsPath + "/web/environments"

	resp := f.api.Post(envs, as(owner), map[string]any{"name": "staging"})
	if p := decode[Project](t, resp); resp.Code != http.StatusOK || !slices.Equal(p.Environments, []string{"production", "staging"}) {
		t.Fatalf("add: %d %s", resp.Code, resp.Body)
	}
	// Adding it again changes nothing.
	if p := decode[Project](t, f.api.Post(envs, as(owner), map[string]any{"name": "staging"})); len(p.Environments) != 2 {
		t.Fatalf("re-add = %+v", p)
	}
	if resp := f.api.Post(envs, as(viewer), map[string]any{"name": "dev"}); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer add: %d", resp.Code)
	}
	if resp := f.api.Post(envs, as(owner), map[string]any{"name": "bad name"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad name: %d", resp.Code)
	}

	resp = f.api.Delete(envs+"/production", as(owner))
	if p := decode[Project](t, resp); resp.Code != http.StatusOK || !slices.Equal(p.Environments, []string{"staging"}) {
		t.Fatalf("remove: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Delete(envs+"/production", as(owner)); resp.Code != http.StatusOK {
		t.Fatalf("remove again: %d", resp.Code)
	}
	if resp := f.api.Delete(envs+"/staging", as(viewer)); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer remove: %d", resp.Code)
	}

	for i := range projects.MaxEnvironments - 1 {
		if resp := f.api.Post(envs, as(owner), map[string]any{"name": "env-" + string(rune('a'+i))}); resp.Code != http.StatusOK {
			t.Fatalf("add %d: %d %s", i, resp.Code, resp.Body)
		}
	}
	if resp := f.api.Post(envs, as(owner), map[string]any{"name": "one-too-many"}); resp.Code != http.StatusBadRequest || decode[problem](t, resp).Code != "invalid_request" {
		t.Fatalf("over limit: %d %s", resp.Code, resp.Body)
	}
}

func TestDeleteProject(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "dp-owner@example.com")
	admin := f.user(t, "dp-admin@example.com")
	member := f.user(t, "dp-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	p := f.mustCreateProject(t, owner, "acme", "Doomed", "doomed")

	if resp := f.api.Delete(ProjectsPath+"/doomed", as(member)); resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "forbidden" {
		t.Fatalf("member delete: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'project.deleted'`); n != 0 {
		t.Fatalf("refused delete emitted %d rows", n)
	}
	resp := f.api.Delete(ProjectsPath+"/doomed", as(admin))
	if resp.Code != http.StatusNoContent || resp.Body.Len() != 0 {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	var aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT aggregate_id, payload FROM outbox WHERE topic = 'project.deleted'`).Scan(&aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if aggregate != p.ID || payload["project_id"] != p.ID {
		t.Fatalf("outbox = %s %v", aggregate, payload)
	}
	if resp := f.api.Get(ProjectsPath+"/doomed", as(owner)); resp.Code != http.StatusForbidden {
		t.Fatalf("get deleted: %d", resp.Code)
	}
	if list := decode[[]Project](t, f.api.Get(OrgsPath+"/acme/projects", as(owner))); len(list) != 0 {
		t.Fatalf("list after delete = %+v", list)
	}
	if resp := f.api.Delete(ProjectsPath+"/doomed", as(owner)); resp.Code != http.StatusForbidden {
		t.Fatalf("second delete: %d", resp.Code)
	}
	// The slug is free again.
	if again := f.mustCreateProject(t, member, "acme", "Reborn", "doomed"); again.ID == p.ID {
		t.Fatal("re-created project reused the id")
	}
}
