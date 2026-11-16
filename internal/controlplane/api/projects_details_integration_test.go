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

func TestUpdateProjectDetails(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	NewProjects(projects.New(f.pool).WithAudit(audit.New(f.pool)), f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, testutil.Logger(t)).Register(f.api)
	owner := f.user(t, "pd-owner@example.com")
	member := f.user(t, "pd-member@example.com")
	viewer := f.user(t, "pd-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	created := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	if created.Description != "" || created.CreatedBy == nil || *created.CreatedBy != owner.String() ||
		created.UpdatedAt.IsZero() || created.ID == "" {
		t.Fatalf("created = %+v", created)
	}
	patch := func(u uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
		return f.api.Patch(ProjectsPath+"/shop", as(u), body)
	}

	// Validation errors leave the project untouched and audit nothing.
	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		body   map[string]any
		status int
		code   string
	}{
		{"description too long", member, map[string]any{"description": strings.Repeat("a", 281)}, http.StatusUnprocessableEntity, ""},
		{"description not a string", member, map[string]any{"description": 7}, http.StatusUnprocessableEntity, ""},
		{"blank name with description", member, map[string]any{"name": " ", "description": "ok"}, http.StatusBadRequest, "invalid_request"},
		{"viewer", viewer, map[string]any{"description": "Nope"}, http.StatusForbidden, "forbidden"},
	} {
		resp := patch(tc.user, tc.body)
		if p := decode[problem](t, resp); resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if got := decode[Project](t, f.api.Get(ProjectsPath+"/shop", as(owner))); got.Description != "" || got.Name != "Shop" || !got.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("after rejected patches = %+v", got)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.updated'`); n != 0 {
		t.Fatalf("project.updated after rejected patches = %d", n)
	}

	// 280 characters (not bytes) is the limit.
	long := strings.Repeat("é", 280)
	resp := patch(member, map[string]any{"description": long})
	p := decode[Project](t, resp)
	if resp.Code != http.StatusOK || p.Description != long || p.Name != "Shop" || !p.UpdatedAt.After(created.UpdatedAt) ||
		p.ID != created.ID || p.CreatedBy == nil || *p.CreatedBy != owner.String() || !p.CreatedAt.Equal(created.CreatedAt) {
		t.Fatalf("patch description: %d %s", resp.Code, resp.Body)
	}

	// Surrounding spaces are trimmed.
	resp = patch(owner, map[string]any{"name": "Storefront", "description": "  Checkout and cart "})
	p = decode[Project](t, resp)
	if resp.Code != http.StatusOK || p.Name != "Storefront" || p.Description != "Checkout and cart" {
		t.Fatalf("patch both: %d %s", resp.Code, resp.Body)
	}
	// Get and list return the new fields.
	got := decode[Project](t, f.api.Get(ProjectsPath+"/shop", as(viewer)))
	if got.Description != "Checkout and cart" || !got.UpdatedAt.Equal(p.UpdatedAt) || got.CreatedBy == nil || got.ID != created.ID {
		t.Fatalf("get = %+v", got)
	}
	list := decode[[]Project](t, f.api.Get(OrgsPath+"/acme/projects", as(viewer)))
	if len(list) != 1 || list[0].Description != "Checkout and cart" || list[0].CreatedBy == nil || !list[0].UpdatedAt.Equal(p.UpdatedAt) {
		t.Fatalf("list = %+v", list)
	}

	// An unchanged value writes nothing; an empty description clears it.
	resp = patch(owner, map[string]any{"name": "Storefront"})
	if q := decode[Project](t, resp); resp.Code != http.StatusOK || !q.UpdatedAt.Equal(p.UpdatedAt) {
		t.Fatalf("no-op patch: %d %s", resp.Code, resp.Body)
	}
	resp = patch(owner, map[string]any{"description": ""})
	if q := decode[Project](t, resp); resp.Code != http.StatusOK || q.Description != "" {
		t.Fatalf("clear description: %d %s", resp.Code, resp.Body)
	}

	// project.updated: one per change, scoped to the project, with the
	// previous and next values of the changed fields only.
	rows, err := f.pool.Query(f.ctx, `SELECT org_id::text, project_id::text, actor_user_id, target_type, target_id, target_label, changes::text
		FROM audit_events WHERE event = 'project.updated' ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct {
		org, project, targetType, targetID, label, changes string
		actor                                              uuid.UUID
	}
	var events []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.org, &r.project, &r.actor, &r.targetType, &r.targetID, &r.label, &r.changes); err != nil {
			t.Fatal(err)
		}
		events = append(events, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("project.updated rows = %d, want 3: %+v", len(events), events)
	}
	for _, r := range events {
		if r.org != created.OrgID || r.project != created.ID || r.targetType != "project" || r.targetID != created.ID {
			t.Fatalf("audit scope = %+v", r)
		}
	}
	if r := events[0]; r.actor != member || r.label != "Shop" ||
		r.changes != `{"next": {"description": "`+long+`"}, "previous": {"description": ""}}` {
		t.Fatalf("first change = %+v", r)
	}
	if r := events[1]; r.actor != owner || r.label != "Storefront" ||
		r.changes != `{"next": {"name": "Storefront", "description": "Checkout and cart"}, "previous": {"name": "Shop", "description": "`+long+`"}}` {
		t.Fatalf("second change = %+v", r)
	}
	if r := events[2]; r.changes != `{"next": {"description": ""}, "previous": {"description": "Checkout and cart"}}` {
		t.Fatalf("third change = %+v", r)
	}
}
