//go:build integration

package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

// projectRolesFixture is org acme with project shop restricted (default
// access none): admin, editor and viewer are org members or viewers with a
// direct project role; outsider is an org member with none.
type projectRolesFixture struct {
	*keysFixture
	org, project uuid.UUID
	users        map[string]uuid.UUID
}

func setupProjectRoles(t *testing.T) *projectRolesFixture {
	t.Helper()
	f := setupKeys(t)
	NewPrivacy(privacy.NewService(f.pool), f.projectGuard(t), testutil.Logger(t)).Register(f.api)
	users := map[string]uuid.UUID{}
	for _, name := range []string{"owner", "admin", "editor", "viewer", "outsider"} {
		users[name] = f.user(t, "pr-"+name+"@example.com")
	}
	org := f.mustCreate(t, users["owner"], "Acme", "acme")
	f.join(t, "acme", users["admin"], "member")
	f.join(t, "acme", users["editor"], "viewer")
	f.join(t, "acme", users["viewer"], "member")
	f.join(t, "acme", users["outsider"], "member")
	p := f.mustCreateProject(t, users["owner"], "acme", "Shop", "shop", "production", "staging")
	rf := &projectRolesFixture{keysFixture: f, org: uuid.MustParse(org.ID), project: uuid.MustParse(p.ID), users: users}
	rf.restrict(t)
	for _, role := range []string{"admin", "editor", "viewer"} {
		rf.grant(t, role, role)
	}
	return rf
}

func (f *projectRolesFixture) restrict(t *testing.T) {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if _, err := db.New(tx).SetProjectDefaultAccess(f.ctx, db.SetProjectDefaultAccessParams{ID: f.project, DefaultAccess: "none"}); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(f.ctx, tx, outbox.ProjectAccessChanged, f.project,
		outbox.ProjectAccessChangedPayload{ProjectID: f.project, OrgID: f.org, DefaultAccess: "none"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func (f *projectRolesFixture) grant(t *testing.T, user, role string) {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	owner := f.users["owner"]
	if _, err := db.New(tx).UpsertProjectMember(f.ctx, db.UpsertProjectMemberParams{ProjectID: f.project, UserID: f.users[user], Role: role, AddedBy: &owner}); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(f.ctx, tx, outbox.ProjectMemberUpserted, f.project,
		outbox.ProjectMemberUpsertedPayload{ProjectID: f.project, OrgID: f.org, UserID: f.users[user], Role: role}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

// newKey creates an ingest key as the owner and returns its id.
func (f *projectRolesFixture) newKey(t *testing.T) string {
	t.Helper()
	resp := f.api.Post(ProjectsPath+"/shop/api-keys", as(f.users["owner"]), map[string]any{"name": "CI", "scopes": []string{"ingest"}})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create key as owner: %d %s", resp.Code, resp.Body)
	}
	return decode[CreatedAPIKey](t, resp).ID
}

// expect requires resp to have status and, for an error, the guard's code.
func expect(t *testing.T, what string, resp *httptest.ResponseRecorder, status int) {
	t.Helper()
	if resp.Code != status {
		t.Errorf("%s: %d %s, want %d", what, resp.Code, resp.Body, status)
		return
	}
	want := map[int]string{http.StatusNotFound: "not_found", http.StatusForbidden: "forbidden"}[status]
	if want != "" {
		if got := decode[problem](t, resp).Code; got != want {
			t.Errorf("%s: code %q, want %q", what, got, want)
		}
	}
}

// TestProjectOperationsFollowProjectRoles runs every project, environment,
// API key and privacy operation as a project admin, editor and viewer and as
// an org member who has no access to the restricted project.
func TestProjectOperationsFollowProjectRoles(t *testing.T) {
	f := setupProjectRoles(t)
	ok, created, gone := http.StatusOK, http.StatusCreated, http.StatusNoContent
	confirm := map[string]any{"confirm": "shop"}
	hidden, refused := http.StatusNotFound, http.StatusForbidden
	type want struct{ admin, editor, viewer, outsider int }
	shop := ProjectsPath + "/shop"

	for _, op := range []struct {
		name string
		do   func(user uuid.UUID) *httptest.ResponseRecorder
		want want
	}{
		{"get-project", func(u uuid.UUID) *httptest.ResponseRecorder { return f.api.Get(shop, as(u)) },
			want{ok, ok, ok, hidden}},
		{"update-project", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Patch(shop, as(u), map[string]any{"name": "Shop"})
		}, want{ok, ok, refused, hidden}},
		{"add-environment", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Post(shop+"/environments", as(u), map[string]any{"name": "qa"})
		}, want{ok, ok, refused, hidden}},
		{"remove-environment", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Delete(shop+"/environments/qa", as(u))
		}, want{ok, ok, refused, hidden}},
		{"get-privacy-policy", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Get(shop+"/privacy-policy", as(u))
		}, want{ok, ok, ok, hidden}},
		{"put-privacy-policy", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Put(shop+"/privacy-policy", as(u), map[string]any{"mask_headers": []string{"x-secret"}})
		}, want{ok, ok, refused, hidden}},
		{"list-api-keys", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Get(shop+"/api-keys", as(u))
		}, want{ok, ok, ok, hidden}},
		{"create-api-key", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Post(shop+"/api-keys", as(u), map[string]any{"name": "CI", "scopes": []string{"ingest"}})
		}, want{created, created, refused, hidden}},
		{"update-api-key-access", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Put(shop+"/api-keys/"+f.newKey(t)+"/access", as(u), map[string]any{"can_create_apps": false, "app_ids": nil})
		}, want{ok, ok, refused, hidden}},
		{"revoke-api-key", func(u uuid.UUID) *httptest.ResponseRecorder {
			return f.api.Delete(shop+"/api-keys/"+f.newKey(t), as(u))
		}, want{gone, gone, refused, hidden}},
	} {
		for _, c := range []struct {
			role   string
			status int
		}{{"admin", op.want.admin}, {"editor", op.want.editor}, {"viewer", op.want.viewer}, {"outsider", op.want.outsider}} {
			expect(t, op.name+" as "+c.role, op.do(f.users[c.role]), c.status)
		}
	}

	// The role on a project is the effective project role.
	for _, role := range []string{"admin", "editor", "viewer"} {
		if got := decode[Project](t, f.api.Get(shop, as(f.users[role]))).Role; got != role {
			t.Errorf("get-project as %s: role %q", role, got)
		}
	}
	if got := decode[Project](t, f.api.Get(shop, as(f.users["owner"]))).Role; got != "admin" {
		t.Errorf("get-project as org owner: role %q, want admin", got)
	}

	// The list holds only projects the caller can view, with their role.
	f.mustCreateProject(t, f.users["owner"], "acme", "Open", "open")
	for user, want := range map[string]map[string]string{
		"owner":    {"open": "admin", "shop": "admin"},
		"admin":    {"open": "editor", "shop": "admin"},
		"editor":   {"open": "viewer", "shop": "editor"},
		"viewer":   {"open": "editor", "shop": "viewer"},
		"outsider": {"open": "editor"},
	} {
		resp := f.api.Get(OrgsPath+"/acme/projects", as(f.users[user]))
		if resp.Code != http.StatusOK {
			t.Fatalf("list as %s: %d %s", user, resp.Code, resp.Body)
		}
		got := map[string]string{}
		for _, p := range decode[[]Project](t, resp) {
			got[p.Slug] = p.Role
		}
		if len(got) != len(want) {
			t.Errorf("list as %s = %v, want %v", user, got, want)
			continue
		}
		for slug, role := range want {
			if got[slug] != role {
				t.Errorf("list as %s = %v, want %v", user, got, want)
				break
			}
		}
	}

	// Delete needs project admin.
	expect(t, "delete-project as editor", f.api.Delete(shop, as(f.users["editor"]), confirm), refused)
	expect(t, "delete-project as viewer", f.api.Delete(shop, as(f.users["viewer"]), confirm), refused)
	expect(t, "delete-project as outsider", f.api.Delete(shop, as(f.users["outsider"]), confirm), hidden)
	expect(t, "delete-project as admin", f.api.Delete(shop, as(f.users["admin"]), confirm), ok)
}
