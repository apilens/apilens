//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

func TestUpdateProjectRepository(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	NewProjects(projects.New(f.pool).WithAudit(audit.New(f.pool)), f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, testutil.Logger(t)).Register(f.api)
	owner := f.user(t, "repo-owner@example.com")
	viewer := f.user(t, "repo-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	created := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	if created.RepositoryURL != nil || created.CommitURLTemplate != nil || created.ReleaseURLTemplate != nil {
		t.Fatalf("created = %+v", created)
	}
	patch := func(u uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
		return f.api.Patch(ProjectsPath+"/shop", as(u), body)
	}

	// Scheme, host and length are checked; a rejected link changes nothing.
	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		url    any
		status int
		code   string
	}{
		{"http", owner, "http://github.com/acme/shop", http.StatusBadRequest, "invalid_request"},
		{"ssh", owner, "git@github.com:acme/shop.git", http.StatusBadRequest, "invalid_request"},
		{"host not allowed", owner, "https://git.example.com/acme/shop", http.StatusBadRequest, "invalid_request"},
		{"credentials", owner, "https://token@github.com/acme/shop", http.StatusBadRequest, "invalid_request"},
		{"no repository", owner, "https://github.com/acme", http.StatusBadRequest, "invalid_request"},
		{"too long", owner, "https://github.com/acme/" + strings.Repeat("a", 2048), http.StatusUnprocessableEntity, ""},
		{"not a string", owner, 7, http.StatusUnprocessableEntity, ""},
		{"viewer", viewer, "https://github.com/acme/shop", http.StatusForbidden, "forbidden"},
	} {
		resp := patch(tc.user, map[string]any{"repository_url": tc.url})
		if p := decode[problem](t, resp); resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if got := decode[Project](t, f.api.Get(ProjectsPath+"/shop", as(owner))); got.RepositoryURL != nil || !got.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("after rejected patches = %+v", got)
	}

	// A link is normalized and the commit and release templates derived.
	resp := patch(owner, map[string]any{"repository_url": " https://GitHub.com/acme/shop.git "})
	p := decode[Project](t, resp)
	if resp.Code != http.StatusOK || p.RepositoryURL == nil || *p.RepositoryURL != "https://github.com/acme/shop" ||
		p.CommitURLTemplate == nil || *p.CommitURLTemplate != "https://github.com/acme/shop/commit/{commit}" ||
		p.ReleaseURLTemplate == nil || *p.ReleaseURLTemplate != "https://github.com/acme/shop/releases/tag/{release}" ||
		!p.UpdatedAt.After(created.UpdatedAt) {
		t.Fatalf("set repository: %d %s", resp.Code, resp.Body)
	}
	got := decode[Project](t, f.api.Get(ProjectsPath+"/shop", as(viewer)))
	if got.RepositoryURL == nil || *got.RepositoryURL != "https://github.com/acme/shop" || got.CommitURLTemplate == nil {
		t.Fatalf("get = %+v", got)
	}
	list := decode[[]Project](t, f.api.Get(OrgsPath+"/acme/projects", as(viewer)))
	if len(list) != 1 || list[0].RepositoryURL == nil || list[0].ReleaseURLTemplate == nil {
		t.Fatalf("list = %+v", list)
	}

	// Leaving it out keeps it; an empty string removes it.
	resp = patch(owner, map[string]any{"description": "Checkout"})
	if q := decode[Project](t, resp); resp.Code != http.StatusOK || q.RepositoryURL == nil {
		t.Fatalf("patch without repository: %d %s", resp.Code, resp.Body)
	}
	resp = patch(owner, map[string]any{"repository_url": ""})
	if q := decode[Project](t, resp); resp.Code != http.StatusOK || q.RepositoryURL != nil || q.CommitURLTemplate != nil || q.ReleaseURLTemplate != nil {
		t.Fatalf("remove repository: %d %s", resp.Code, resp.Body)
	}

	// project.updated records the previous and next link.
	var changes []string
	rows, err := f.pool.Query(f.ctx, `SELECT changes::text FROM audit_events
		WHERE event = 'project.updated' AND changes ? 'next' AND changes->'next' ? 'repository_url' ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		changes = append(changes, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 ||
		changes[0] != `{"next": {"repository_url": "https://github.com/acme/shop"}, "previous": {"repository_url": null}}` ||
		changes[1] != `{"next": {"repository_url": null}, "previous": {"repository_url": "https://github.com/acme/shop"}}` {
		t.Fatalf("audit changes = %q", changes)
	}
}
