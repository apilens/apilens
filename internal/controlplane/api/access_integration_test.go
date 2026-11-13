//go:build integration

package api

import (
	"net/http"
	"net/url"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/access"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

type accessFixture struct {
	*orgsFixture
	org     uuid.UUID
	project uuid.UUID
	users   map[string]uuid.UUID
}

type accessList struct {
	DefaultAccess string         `json:"default_access"`
	Members       []AccessMember `json:"members"`
	NextCursor    string         `json:"next_cursor"`
}

// setupAccess is org acme with an owner, an admin, two members and two
// viewers, and project shop.
func setupAccess(t *testing.T) *accessFixture {
	t.Helper()
	f := setupProjects(t)
	logger := testutil.Logger(t)
	guard := authz.NewGuard(f.authz, authz.NewPGResolver(f.pool), authz.GuardOptions{}, logger)
	NewAccess(access.New(f.pool), guard, logger).Register(f.api)

	users := map[string]uuid.UUID{}
	for _, name := range []string{"owner", "admin", "member", "member2", "viewer", "viewer2", "stranger"} {
		users[name] = f.user(t, "acc-"+name+"@example.com")
	}
	org := f.mustCreate(t, users["owner"], "Acme", "acme")
	f.join(t, "acme", users["admin"], "admin")
	f.join(t, "acme", users["member"], "member")
	f.join(t, "acme", users["member2"], "member")
	f.join(t, "acme", users["viewer"], "viewer")
	f.join(t, "acme", users["viewer2"], "viewer")
	p := f.mustCreateProject(t, users["owner"], "acme", "Shop", "shop")
	return &accessFixture{orgsFixture: f, org: uuid.MustParse(org.ID), project: uuid.MustParse(p.ID), users: users}
}

// grant gives user a direct role on the project, as the owner, through the
// outbox.
func (f *accessFixture) grant(t *testing.T, user, role string) {
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

func (f *accessFixture) setDefault(t *testing.T, def string) {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if _, err := db.New(tx).SetProjectDefaultAccess(f.ctx, db.SetProjectDefaultAccessParams{ID: f.project, DefaultAccess: def}); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(f.ctx, tx, outbox.ProjectAccessChanged, f.project,
		outbox.ProjectAccessChangedPayload{ProjectID: f.project, OrgID: f.org, DefaultAccess: def}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

func (f *accessFixture) get(user uuid.UUID, query url.Values) (int, string) {
	path := ProjectsPath + "/shop/access"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	resp := f.api.Get(path, as(user))
	return resp.Code, resp.Body.String()
}

func (f *accessFixture) list(t *testing.T, user string, query url.Values) accessList {
	t.Helper()
	path := ProjectsPath + "/shop/access"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	resp := f.api.Get(path, as(f.users[user]))
	if resp.Code != http.StatusOK {
		t.Fatalf("list access as %s: %d %s", user, resp.Code, resp.Body)
	}
	return decode[accessList](t, resp)
}

func byUser(l accessList) map[uuid.UUID]AccessMember {
	out := map[uuid.UUID]AccessMember{}
	for _, m := range l.Members {
		out[uuid.MustParse(m.UserID)] = m
	}
	return out
}

// agreesWithSpiceDB requires the listed effective role of every fixture
// user to match what SpiceDB answers: admin ⇔ manage_access, editor ⇔ edit
// without manage_access, viewer ⇔ view without edit, unlisted ⇔ no view.
func (f *accessFixture) agreesWithSpiceDB(t *testing.T, l accessList) {
	t.Helper()
	listed := byUser(l)
	res := authz.Project(f.org.String(), f.project.String())
	for name, id := range f.users {
		var got string
		for _, perm := range []struct {
			p    authz.Permission
			role string
		}{{authz.ProjectManageAccess, "admin"}, {authz.ProjectEdit, "editor"}, {authz.ProjectView, "viewer"}} {
			ok, err := f.authz.Check(f.ctx, authz.User(id.String()), perm.p, res)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				got = perm.role
				break
			}
		}
		m, ok := listed[id]
		switch {
		case !ok && got != "":
			t.Errorf("%s: not listed, SpiceDB says %s", name, got)
		case ok && m.EffectiveRole != got:
			t.Errorf("%s: effective_role %s, SpiceDB says %q", name, m.EffectiveRole, got)
		}
	}
}

func sourceKinds(m AccessMember) []string {
	var out []string
	for _, s := range m.Sources {
		out = append(out, s.Kind+":"+s.Role)
	}
	return out
}

func TestProjectAccessList(t *testing.T) {
	f := setupAccess(t)
	f.grant(t, "member2", "admin")
	f.grant(t, "viewer2", "editor")

	// Default access org_role: every org member is listed.
	l := f.list(t, "viewer", nil)
	if l.DefaultAccess != "org_role" || len(l.Members) != 6 || l.NextCursor != "" {
		t.Fatalf("list = %+v", l)
	}
	got := byUser(l)
	owner := got[f.users["owner"]]
	if owner.EffectiveRole != "admin" || len(owner.Sources) != 1 || owner.Sources[0] != (AccessSource{Kind: "org_role", Role: "admin", OrgRole: "owner"}) ||
		owner.DirectRole != nil || owner.AddedBy != nil || owner.AvatarInitials != "A" || owner.Email != "acc-owner@example.com" {
		t.Fatalf("owner = %+v", owner)
	}
	m2 := got[f.users["member2"]]
	if m2.EffectiveRole != "admin" || !slices.Equal(sourceKinds(m2), []string{"default:editor", "direct:admin"}) ||
		m2.DirectRole == nil || *m2.DirectRole != "admin" || m2.AddedBy == nil || m2.AddedBy.ID != f.users["owner"].String() {
		t.Fatalf("member with a direct admin grant = %+v", m2)
	}
	if m := got[f.users["member"]]; m.EffectiveRole != "editor" || m.Sources[0] != (AccessSource{Kind: "default", Role: "editor", OrgRole: "member"}) {
		t.Fatalf("member = %+v", m)
	}
	if v := got[f.users["viewer2"]]; v.EffectiveRole != "editor" || !slices.Equal(sourceKinds(v), []string{"default:viewer", "direct:editor"}) {
		t.Fatalf("viewer with a direct editor grant = %+v", v)
	}
	f.agreesWithSpiceDB(t, l)

	// Filters.
	if l := f.list(t, "owner", url.Values{"role": {"admin"}}); len(l.Members) != 3 {
		t.Fatalf("role=admin: %d members", len(l.Members))
	}
	if l := f.list(t, "owner", url.Values{"source": {"direct"}}); len(l.Members) != 2 {
		t.Fatalf("source=direct: %d members", len(l.Members))
	}
	if l := f.list(t, "owner", url.Values{"q": {"ACC-MEMBER"}}); len(l.Members) != 2 {
		t.Fatalf("q=ACC-MEMBER: %d members", len(l.Members))
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET name = 'Grace Hopper' WHERE id = $1`, f.users["viewer"]); err != nil {
		t.Fatal(err)
	}
	if l := f.list(t, "owner", url.Values{"q": {"hopper"}}); len(l.Members) != 1 || l.Members[0].AvatarInitials != "GH" {
		t.Fatalf("q=hopper: %+v", l.Members)
	}
	if l := f.list(t, "owner", url.Values{"q": {"%"}}); len(l.Members) != 0 {
		t.Fatalf("q=%%: wildcard not escaped, %d members", len(l.Members))
	}

	// Cursor pagination walks everyone once, by email.
	var emails []string
	q := url.Values{"limit": {"4"}}
	for pages := 0; ; pages++ {
		if pages > 3 {
			t.Fatal("pagination does not end")
		}
		page := f.list(t, "owner", q)
		for _, m := range page.Members {
			emails = append(emails, m.Email)
		}
		if page.NextCursor == "" {
			break
		}
		q.Set("cursor", page.NextCursor)
	}
	if len(emails) != 6 || !slices.IsSorted(emails) {
		t.Fatalf("paged emails = %v", emails)
	}
	if code, body := f.get(f.users["owner"], url.Values{"cursor": {"bogus"}}); code != http.StatusBadRequest && code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor: %d %s", code, body)
	}

	// Default access viewer: members only view.
	f.setDefault(t, "viewer")
	l = f.list(t, "owner", nil)
	if l.DefaultAccess != "viewer" || len(l.Members) != 6 || byUser(l)[f.users["member"]].EffectiveRole != "viewer" {
		t.Fatalf("viewer default = %+v", l)
	}
	f.agreesWithSpiceDB(t, l)

	// Restricted: only owners, admins and direct grants are listed.
	f.setDefault(t, "none")
	l = f.list(t, "member2", nil)
	got = byUser(l)
	if l.DefaultAccess != "none" || len(l.Members) != 4 {
		t.Fatalf("restricted = %+v", l)
	}
	for _, name := range []string{"member", "viewer"} {
		if _, ok := got[f.users[name]]; ok {
			t.Fatalf("restricted project lists %s without a grant", name)
		}
	}
	if m := got[f.users["member2"]]; !slices.Equal(sourceKinds(m), []string{"direct:admin"}) {
		t.Fatalf("restricted member2 = %+v", m)
	}
	f.agreesWithSpiceDB(t, l)

	// A caller who cannot view the project gets 404.
	for _, name := range []string{"member", "stranger"} {
		if code, body := f.get(f.users[name], nil); code != http.StatusNotFound {
			t.Fatalf("%s: %d %s, want 404", name, code, body)
		}
	}
	if code, _ := f.get(f.users["owner"], nil); code != http.StatusOK {
		t.Fatalf("owner on restricted project: %d", code)
	}
}
