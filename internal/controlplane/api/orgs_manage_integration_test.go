//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// join adds user to the organization slug with role.
func (f *orgsFixture) join(t *testing.T, slug string, user uuid.UUID, role string) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO memberships (org_id, user_id, role) SELECT id, $2, $3 FROM organizations WHERE slug = $1 AND deleted_at IS NULL`, slug, user, role); err != nil {
		t.Fatal(err)
	}
}

func (f *orgsFixture) mustCreate(t *testing.T, user uuid.UUID, name, slug string) Org {
	t.Helper()
	resp := f.create(user, name, slug)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create %s: %d %s", slug, resp.Code, resp.Body)
	}
	return decode[Org](t, resp)
}

func TestListOrgs(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "list-owner@example.com")
	member := f.user(t, "list-member@example.com")
	loner := f.user(t, "loner@example.com")

	beta := f.mustCreate(t, owner, "Beta", "beta")
	f.mustCreate(t, owner, "Alpha", "alpha")
	f.mustCreate(t, loner, "Elsewhere", "elsewhere")
	f.join(t, "beta", member, "viewer")
	for _, slug := range []string{"web", "api-gw"} {
		if _, err := f.pool.Exec(f.ctx, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, $3, $3)`, uuid.New(), uuid.MustParse(beta.ID), slug); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE projects SET deleted_at = now() WHERE slug = 'api-gw'`); err != nil {
		t.Fatal(err)
	}

	resp := f.api.Get(OrgsPath, as(owner))
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	list := decode[[]OrgSummary](t, resp)
	if len(list) != 2 || list[0].Slug != "alpha" || list[1].Slug != "beta" {
		t.Fatalf("list = %+v", list)
	}
	if a := list[0]; a.Role != "owner" || a.ProjectCount != 0 || a.MemberCount != 1 || a.Name != "Alpha" || a.CreatedAt.IsZero() {
		t.Fatalf("alpha = %+v", a)
	}
	if b := list[1]; b.Role != "owner" || b.ProjectCount != 1 || b.MemberCount != 2 || b.ID != beta.ID {
		t.Fatalf("beta = %+v", b)
	}

	list = decode[[]OrgSummary](t, f.api.Get(OrgsPath, as(member)))
	if len(list) != 1 || list[0].Slug != "beta" || list[0].Role != "viewer" {
		t.Fatalf("member list = %+v", list)
	}

	nobody := f.user(t, "nobody@example.com")
	if resp := f.api.Get(OrgsPath, as(nobody)); resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != "[]" {
		t.Fatalf("empty list: %d %s", resp.Code, resp.Body)
	}
}

func TestGetOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "get-owner@example.com")
	member := f.user(t, "get-member@example.com")
	stranger := f.user(t, "get-stranger@example.com")
	created := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")

	resp := f.api.Get(OrgsPath+"/acme", as(member))
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	d := decode[OrgDetail](t, resp)
	if d.ID != created.ID || d.Slug != "acme" || d.Name != "Acme" || d.Role != "member" || d.DomainJoin || d.AllowedDomains == nil || len(d.AllowedDomains) != 0 {
		t.Fatalf("detail = %+v", d)
	}

	// A stranger cannot tell an existing organization from a missing one.
	a, b := f.api.Get(OrgsPath+"/acme", as(stranger)), f.api.Get(OrgsPath+"/missing", as(stranger))
	if a.Code != http.StatusForbidden || decode[problem](t, a).Code != "forbidden" || a.Code != b.Code || a.Body.String() != b.Body.String() {
		t.Fatalf("stranger: %d %s / %d %s", a.Code, a.Body, b.Code, b.Body)
	}
}

func TestUpdateOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "upd-owner@example.com")
	admin := f.user(t, "upd-admin@example.com")
	member := f.user(t, "upd-member@example.com")
	viewer := f.user(t, "upd-viewer@example.com")
	stranger := f.user(t, "upd-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	patch := func(u uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
		return f.api.Patch(OrgsPath+"/acme", as(u), body)
	}

	resp := patch(admin, map[string]any{"name": "  Acme Corp ", "allowed_domains": []string{"acme.com", "acme.io", "acme.com"}, "domain_join": true})
	if resp.Code != http.StatusOK {
		t.Fatalf("admin patch: %d %s", resp.Code, resp.Body)
	}
	d := decode[OrgDetail](t, resp)
	if d.Name != "Acme Corp" || !slices.Equal(d.AllowedDomains, []string{"acme.com", "acme.io"}) || !d.DomainJoin || d.Role != "admin" || d.Slug != "acme" {
		t.Fatalf("patched = %+v", d)
	}

	// Omitted fields are unchanged; the current slug is accepted.
	resp = patch(owner, map[string]any{"slug": "acme", "domain_join": false})
	if d := decode[OrgDetail](t, resp); resp.Code != http.StatusOK || d.Name != "Acme Corp" || len(d.AllowedDomains) != 2 || d.DomainJoin || d.Role != "owner" {
		t.Fatalf("owner patch: %d %s", resp.Code, resp.Body)
	}
	got := decode[OrgDetail](t, f.api.Get(OrgsPath+"/acme", as(member)))
	if got.Name != "Acme Corp" || len(got.AllowedDomains) != 2 || got.DomainJoin {
		t.Fatalf("persisted = %+v", got)
	}

	// An empty list clears the domains.
	resp = patch(owner, map[string]any{"allowed_domains": []string{}})
	if d := decode[OrgDetail](t, resp); resp.Code != http.StatusOK || d.AllowedDomains == nil || len(d.AllowedDomains) != 0 {
		t.Fatalf("clear domains: %d %s", resp.Code, resp.Body)
	}

	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		body   map[string]any
		status int
		code   string
	}{
		{"member", member, map[string]any{"name": "Nope"}, http.StatusForbidden, "forbidden"},
		{"viewer", viewer, map[string]any{"name": "Nope"}, http.StatusForbidden, "forbidden"},
		{"stranger", stranger, map[string]any{"name": "Nope"}, http.StatusForbidden, "forbidden"},
		{"slug change", owner, map[string]any{"slug": "acme-new"}, http.StatusConflict, "slug_immutable"},
		{"public domain", owner, map[string]any{"allowed_domains": []string{"acme.com", "gmail.com"}}, http.StatusBadRequest, "domain_not_allowed"},
		{"public domain outlook", admin, map[string]any{"allowed_domains": []string{"outlook.com"}}, http.StatusBadRequest, "domain_not_allowed"},
		{"upper-case domain", owner, map[string]any{"allowed_domains": []string{"Acme.com"}}, http.StatusBadRequest, "invalid_request"},
		{"not a hostname", owner, map[string]any{"allowed_domains": []string{"acme"}}, http.StatusBadRequest, "invalid_request"},
		{"blank name", owner, map[string]any{"name": "   "}, http.StatusBadRequest, "invalid_request"},
	} {
		resp := patch(tc.user, tc.body)
		if p := decode[problem](t, resp); resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if resp := patch(owner, map[string]any{"name": ""}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("empty name: %d", resp.Code)
	}
	got = decode[OrgDetail](t, f.api.Get(OrgsPath+"/acme", as(owner)))
	if got.Name != "Acme Corp" || len(got.AllowedDomains) != 0 || got.Slug != "acme" {
		t.Fatalf("rejected patches changed the org: %+v", got)
	}

	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'org.updated'`); n != 3 {
		t.Fatalf("org.updated audit events = %d, want 3", n)
	}
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT metadata FROM audit_events WHERE event = 'org.updated' AND actor_user_id = $1`, admin).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if fields, _ := meta["fields"].([]any); len(fields) != 3 || meta["slug"] != "acme" {
		t.Fatalf("audit meta = %v", meta)
	}
}

func TestDeleteOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "del-owner@example.com")
	admin := f.user(t, "del-admin@example.com")
	stranger := f.user(t, "del-stranger@example.com")
	org := f.mustCreate(t, owner, "Doomed", "doomed")
	f.join(t, "doomed", admin, "admin")

	for _, u := range []uuid.UUID{admin, stranger} {
		if resp := f.api.Delete(OrgsPath+"/doomed", as(u)); resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "forbidden" {
			t.Fatalf("non-owner delete: %d %s", resp.Code, resp.Body)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'org.deleted'`); n != 0 {
		t.Fatalf("refused delete emitted %d outbox rows", n)
	}

	resp := f.api.Delete(OrgsPath+"/doomed", as(owner))
	if resp.Code != http.StatusNoContent || resp.Body.Len() != 0 {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM organizations WHERE slug = 'doomed' AND deleted_at IS NOT NULL`); n != 1 {
		t.Fatalf("soft-deleted rows = %d", n)
	}
	var aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT aggregate_id, payload FROM outbox WHERE topic = 'org.deleted'`).Scan(&aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if aggregate != org.ID || payload["org_id"] != org.ID {
		t.Fatalf("outbox = %s %v", aggregate, payload)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'org.deleted' AND actor_user_id = $1 AND metadata->>'org_id' = $2`, owner, org.ID); n != 1 {
		t.Fatalf("org.deleted audit events = %d", n)
	}

	// Gone for everyone; the slug is free again.
	for _, u := range []uuid.UUID{owner, admin} {
		if resp := f.api.Get(OrgsPath+"/doomed", as(u)); resp.Code != http.StatusForbidden {
			t.Fatalf("get deleted: %d", resp.Code)
		}
		if list := decode[[]OrgSummary](t, f.api.Get(OrgsPath, as(u))); len(list) != 0 {
			t.Fatalf("list after delete = %+v", list)
		}
	}
	if resp := f.api.Delete(OrgsPath+"/doomed", as(owner)); resp.Code != http.StatusForbidden {
		t.Fatalf("second delete: %d", resp.Code)
	}
	if a := decode[availability](t, f.api.Get(SlugAvailablePath+"?slug=doomed", as(owner))); !a.Available {
		t.Fatal("slug of deleted org is not available")
	}
}
