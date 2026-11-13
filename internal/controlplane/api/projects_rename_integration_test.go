//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestRenameProjectSlug renames a project's slug: the old slug keeps
// resolving to it (Content-Location and canonical_slug name the new one),
// another project cannot take the old slug for 30 days, the same project
// can take it back, and after 30 days it is free again.
func TestRenameProjectSlug(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	f.api.UseMiddleware(authz.ContentLocation)
	NewProjects(projects.New(f.pool).WithAudit(audit.New(f.pool)), f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, testutil.Logger(t)).Register(f.api)
	owner := f.user(t, "rn-owner@example.com")
	member := f.user(t, "rn-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	shop := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	f.mustCreateProject(t, owner, "acme", "Other", "other")
	rename := func(user uuid.UUID, from, to string, extra ...any) *httptest.ResponseRecorder {
		args := append([]any{as(user)}, extra...)
		return f.api.Post(ProjectsPath+"/"+from+"/rename", append(args, map[string]any{"slug": to})...)
	}
	wantProblem := func(name string, resp *httptest.ResponseRecorder, status int, code string) problem {
		t.Helper()
		p := decode[problem](t, resp)
		if resp.Code != status || p.Code != code {
			t.Fatalf("%s: %d %s, want %d %s", name, resp.Code, resp.Body, status, code)
		}
		return p
	}

	// Refusals change nothing.
	wantProblem("editor", rename(member, "shop", "store"), http.StatusForbidden, "forbidden")
	wantProblem("stale sign-in", rename(owner, "shop", "store", signedIn(11*time.Minute)), http.StatusForbidden, "reauth_required")
	wantProblem("taken", rename(owner, "shop", "other"), http.StatusConflict, "slug_taken")
	wantProblem("reserved word", rename(owner, "shop", "api"), http.StatusConflict, "slug_taken")
	if resp := rename(owner, "shop", "Bad Slug"); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid slug: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM project_slug_history`); n != 0 {
		t.Fatalf("history after refusals = %d", n)
	}

	// Renaming to the current slug changes nothing.
	if resp := rename(owner, "shop", "shop"); resp.Code != http.StatusOK || decode[Project](t, resp).Slug != "shop" {
		t.Fatalf("same slug: %d %s", resp.Code, resp.Body)
	}

	// Rename.
	resp := rename(owner, "shop", "store")
	p := decode[Project](t, resp)
	if resp.Code != http.StatusOK || p.Slug != "store" || p.CanonicalSlug != "store" || p.ID != shop.ID || p.Role != "admin" ||
		!p.UpdatedAt.After(shop.UpdatedAt) {
		t.Fatalf("rename: %d %s", resp.Code, resp.Body)
	}
	var changes string
	if err := f.pool.QueryRow(f.ctx, `SELECT changes::text FROM audit_events WHERE event = 'project.slug_changed' AND project_id = $1`, shop.ID).Scan(&changes); err != nil {
		t.Fatalf("project.slug_changed: %v", err)
	}
	if changes != `{"next": {"slug": "store"}, "previous": {"slug": "shop"}}` {
		t.Fatalf("project.slug_changed changes = %s", changes)
	}

	// The old slug resolves to the project, for reads and writes, and
	// names the current slug.
	resp = f.api.Get(ProjectsPath+"/shop", as(member))
	if got := decode[Project](t, resp); resp.Code != http.StatusOK || got.ID != shop.ID || got.CanonicalSlug != "store" ||
		resp.Header().Get("Content-Location") != ProjectsPath+"/store" {
		t.Fatalf("get by old slug: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
	resp = f.api.Post(ProjectsPath+"/shop/environments", as(member), map[string]any{"name": "staging"})
	if resp.Code != http.StatusOK || resp.Header().Get("Content-Location") != ProjectsPath+"/store/environments" {
		t.Fatalf("add environment by old slug: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
	resp = f.api.Get(ProjectsPath+"/store", as(member))
	if resp.Code != http.StatusOK || resp.Header().Get("Content-Location") != "" {
		t.Fatalf("get by new slug: %d %v", resp.Code, resp.Header())
	}

	// For 30 days no other project can take the old slug.
	slugAvailable := func(slug string) bool {
		t.Helper()
		resp := f.api.Get(ProjectSlugAvailablePath+"?slug="+slug, as(owner))
		if resp.Code != http.StatusOK {
			t.Fatalf("slug-available %s: %d %s", slug, resp.Code, resp.Body)
		}
		return decode[ProjectSlugAvailableOutput](t, resp).Body.Available
	}
	if slugAvailable("shop") {
		t.Fatal("slug-available reports a reserved slug as free")
	}
	pr := wantProblem("create on reserved", f.createProject(owner, "acme", "Shop 2", "shop"), http.StatusConflict, "slug_taken")
	f.checkSuggestions(t, pr.Suggestions)
	wantProblem("rename onto reserved", rename(owner, "other", "shop"), http.StatusConflict, "slug_taken")

	// The same project can take it back; its newer slug is then retired
	// and resolves to it in turn.
	resp = rename(owner, "store", "shop")
	if p := decode[Project](t, resp); resp.Code != http.StatusOK || p.Slug != "shop" || p.ID != shop.ID {
		t.Fatalf("rename back: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM project_slug_history WHERE slug = 'shop'`); n != 0 {
		t.Fatalf("history keeps the slug in use: %d", n)
	}
	resp = f.api.Get(ProjectsPath+"/store", as(owner))
	if got := decode[Project](t, resp); resp.Code != http.StatusOK || got.ID != shop.ID || resp.Header().Get("Content-Location") != ProjectsPath+"/shop" {
		t.Fatalf("get by retired store: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.slug_changed'`); n != 2 {
		t.Fatalf("project.slug_changed events = %d, want 2", n)
	}

	// After 30 days another project may take it; the old slug then names
	// the new project.
	f.exec(t, `UPDATE project_slug_history SET retired_at = now() - interval '31 days' WHERE slug = 'store'`)
	if !slugAvailable("store") {
		t.Fatal("slug-available: store not free after 30 days")
	}
	store := f.mustCreateProject(t, owner, "acme", "Store", "store")
	resp = f.api.Get(ProjectsPath+"/store", as(owner))
	if got := decode[Project](t, resp); resp.Code != http.StatusOK || got.ID != store.ID || resp.Header().Get("Content-Location") != "" {
		t.Fatalf("get store after reuse: %d %v %s", resp.Code, resp.Header(), resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM project_slug_history WHERE slug = 'store'`); n != 0 {
		t.Fatalf("history keeps a reused slug: %d", n)
	}
}

// TestRenameProjectSlugResolvesForQueryGuard checks authz.PGResolver, which
// the api and query roles share: a retired slug resolves to its project
// with the current slug until another project takes it.
func TestRenameProjectSlugResolvesForQueryGuard(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	NewProjects(projects.New(f.pool), f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, testutil.Logger(t)).Register(f.api)
	owner := f.user(t, "rq-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	shop := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	svc := projects.New(f.pool)
	if _, err := svc.Rename(f.ctx, owner, uuid.MustParse(shop.ID), "store"); err != nil {
		t.Fatal(err)
	}
	r := authz.NewPGResolver(f.pool)
	for _, slug := range []string{"shop", "store"} {
		id, _, canonical, err := r.ProjectCanonical(f.ctx, slug)
		if err != nil || id.String() != shop.ID || canonical != "store" {
			t.Fatalf("%s: %s %s %v", slug, id, canonical, err)
		}
	}
	if _, _, _, err := r.ProjectCanonical(f.ctx, "nope"); err != authz.ErrNoResource {
		t.Fatalf("unknown slug: %v", err)
	}
}
