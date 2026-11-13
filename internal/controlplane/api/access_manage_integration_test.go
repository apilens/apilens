//go:build integration

package api

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/authz"
)

// testMaxDirectMembers is access.max_direct_members_per_project in the
// access fixture.
const testMaxDirectMembers = 4

type defaultAccessResult struct {
	DefaultAccess         string `json:"default_access"`
	PreviousDefaultAccess string `json:"previous_default_access"`
	LoseAccess            int64  `json:"lose_access"`
	DryRun                bool   `json:"dry_run"`
}

// putRole sets user's direct role as caller and returns the status and body.
func (f *accessFixture) putRole(caller, user, role string, headers ...any) (int, string) {
	args := append([]any{as(f.users[caller])}, headers...)
	args = append(args, map[string]any{"role": role})
	resp := f.api.Put(ProjectsPath+"/shop/members/"+f.users[user].String(), args...)
	return resp.Code, resp.Body.String()
}

func (f *accessFixture) deleteRole(caller, user string) (int, string) {
	resp := f.api.Delete(ProjectsPath+"/shop/members/"+f.users[user].String(), as(f.users[caller]))
	return resp.Code, resp.Body.String()
}

func (f *accessFixture) patchDefault(t *testing.T, caller, def string, dryRun bool) defaultAccessResult {
	t.Helper()
	path := ProjectsPath + "/shop/access"
	if dryRun {
		path += "?dry_run=true"
	}
	resp := f.api.Patch(path, as(f.users[caller]), map[string]any{"default_access": def})
	if resp.Code != http.StatusOK {
		t.Fatalf("set default %s as %s: %d %s", def, caller, resp.Code, resp.Body)
	}
	return decode[defaultAccessResult](t, resp)
}

// can answers SpiceDB Check for user on the project, after a request has
// drained the outbox relay.
func (f *accessFixture) can(t *testing.T, user string, perm authz.Permission) bool {
	t.Helper()
	f.api.Get(ProjectsPath+"/shop/access", as(f.users["owner"]))
	ok, err := f.authz.Check(f.ctx, authz.User(f.users[user].String()), perm, authz.Project(f.org.String(), f.project.String()))
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func (f *accessFixture) auditCount(t *testing.T, event string) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM audit_events WHERE event = $1 AND project_id = $2`, event, f.project).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func wantCode(t *testing.T, what string, code int, body string, status int, errCode string) {
	t.Helper()
	if code != status || !strings.Contains(body, `"code":"`+errCode+`"`) {
		t.Fatalf("%s: %d %s, want %d %s", what, code, body, status, errCode)
	}
}

func TestProjectAccessGrantChangeRemove(t *testing.T) {
	f := setupAccess(t)

	// Who may manage access: 404 for a non-viewer, 403 for a viewer or editor.
	code, body := f.putRole("stranger", "member2", "admin")
	wantCode(t, "stranger", code, body, http.StatusNotFound, "not_found")
	code, body = f.putRole("viewer", "member2", "admin")
	wantCode(t, "viewer", code, body, http.StatusForbidden, "forbidden")
	code, body = f.putRole("member", "member2", "admin")
	wantCode(t, "editor", code, body, http.StatusForbidden, "forbidden")
	code, body = f.deleteRole("member", "member2")
	wantCode(t, "editor removes", code, body, http.StatusForbidden, "forbidden")
	// A sign-in older than 10 minutes must be confirmed again.
	code, body = f.putRole("owner", "member2", "admin", signedIn(20*time.Minute))
	wantCode(t, "stale session", code, body, http.StatusForbidden, "reauth_required")
	// Only org members can be granted a role.
	code, body = f.putRole("owner", "stranger", "viewer")
	wantCode(t, "outsider", code, body, http.StatusConflict, "not_org_member")
	code, body = f.deleteRole("owner", "stranger")
	wantCode(t, "remove outsider", code, body, http.StatusConflict, "not_org_member")

	// Grant.
	code, body = f.putRole("owner", "member2", "admin")
	if code != http.StatusOK || !strings.Contains(body, `"effective_role":"admin"`) || !strings.Contains(body, `"direct_role":"admin"`) {
		t.Fatalf("grant admin: %d %s", code, body)
	}
	if !f.can(t, "member2", authz.ProjectManageAccess) {
		t.Fatal("member2 granted admin cannot manage access")
	}
	if n := f.auditCount(t, "project_member.added"); n != 1 {
		t.Fatalf("project_member.added events = %d", n)
	}
	// A direct admin manages access too.
	if code, body := f.putRole("member2", "viewer2", "editor"); code != http.StatusOK {
		t.Fatalf("direct admin grants: %d %s", code, body)
	}
	if !f.can(t, "viewer2", authz.ProjectEdit) {
		t.Fatal("viewer2 granted editor cannot edit")
	}

	// Change to a role lower than the org gives: allowed, the effective
	// role says so.
	code, body = f.putRole("owner", "member2", "viewer")
	if code != http.StatusOK || !strings.Contains(body, `"effective_role":"editor"`) || !strings.Contains(body, `"direct_role":"viewer"`) {
		t.Fatalf("change to viewer: %d %s", code, body)
	}
	if f.can(t, "member2", authz.ProjectManageAccess) || !f.can(t, "member2", authz.ProjectEdit) {
		t.Fatal("member2 changed to viewer: want edit through the org role, no manage_access")
	}
	if n := f.auditCount(t, "project_member.role_changed"); n != 1 {
		t.Fatalf("project_member.role_changed events = %d", n)
	}
	// Setting the same role again changes nothing.
	if code, _ := f.putRole("owner", "member2", "viewer"); code != http.StatusOK || f.auditCount(t, "project_member.role_changed") != 1 {
		t.Fatalf("same role: %d, events %d", code, f.auditCount(t, "project_member.role_changed"))
	}

	// Remove.
	if code, body := f.deleteRole("owner", "viewer2"); code != http.StatusNoContent {
		t.Fatalf("remove: %d %s", code, body)
	}
	if f.can(t, "viewer2", authz.ProjectEdit) || !f.can(t, "viewer2", authz.ProjectView) {
		t.Fatal("viewer2 after removal: want view through the default access, no edit")
	}
	if n := f.auditCount(t, "project_member.removed"); n != 1 {
		t.Fatalf("project_member.removed events = %d", n)
	}
	// Removing a grant that does not exist is a no-op.
	if code, _ := f.deleteRole("owner", "viewer2"); code != http.StatusNoContent || f.auditCount(t, "project_member.removed") != 1 {
		t.Fatalf("remove again: %d", code)
	}
	// A caller may remove their own grant.
	if code, body := f.putRole("owner", "admin", "admin"); code != http.StatusOK {
		t.Fatalf("grant org admin: %d %s", code, body)
	}
	if code, body := f.deleteRole("admin", "admin"); code != http.StatusNoContent {
		t.Fatalf("remove own grant: %d %s", code, body)
	}
	if !f.can(t, "admin", authz.ProjectManageAccess) {
		t.Fatal("org admin lost manage_access with their direct grant")
	}
	f.agreesWithSpiceDB(t, f.list(t, "owner", nil))
}

func TestProjectAccessDefault(t *testing.T) {
	f := setupAccess(t)
	if code, body := f.putRole("owner", "viewer2", "editor"); code != http.StatusOK {
		t.Fatalf("grant: %d %s", code, body)
	}

	resp := f.api.Patch(ProjectsPath+"/shop/access?dry_run=true", as(f.users["member"]), map[string]any{"default_access": "none"})
	wantCode(t, "editor sets default", resp.Code, resp.Body.String(), http.StatusForbidden, "forbidden")

	// Dry run: member, member2 and viewer lose access; nothing changes.
	r := f.patchDefault(t, "owner", "none", true)
	if !r.DryRun || r.LoseAccess != 3 || r.DefaultAccess != "org_role" || r.PreviousDefaultAccess != "org_role" {
		t.Fatalf("dry run = %+v", r)
	}
	if l := f.list(t, "owner", nil); l.DefaultAccess != "org_role" || len(l.Members) != 6 {
		t.Fatalf("dry run changed access: %+v", l)
	}
	if !f.can(t, "member", authz.ProjectEdit) || f.auditCount(t, "project.access_changed") != 0 {
		t.Fatal("dry run changed access")
	}

	// Restricted.
	r = f.patchDefault(t, "owner", "none", false)
	if r.DryRun || r.LoseAccess != 3 || r.DefaultAccess != "none" || r.PreviousDefaultAccess != "org_role" {
		t.Fatalf("set none = %+v", r)
	}
	if f.can(t, "member", authz.ProjectView) || f.can(t, "viewer", authz.ProjectView) || !f.can(t, "viewer2", authz.ProjectEdit) {
		t.Fatal("restricted project: want only the direct grant and org admins")
	}
	if n := f.auditCount(t, "project.access_changed"); n != 1 {
		t.Fatalf("project.access_changed events = %d", n)
	}
	l := f.list(t, "owner", nil)
	if l.DefaultAccess != "none" || len(l.Members) != 3 {
		t.Fatalf("restricted list: %+v", l)
	}
	f.agreesWithSpiceDB(t, l)
	// A non-viewer now gets 404.
	if code := f.api.Patch(ProjectsPath+"/shop/access", as(f.users["member"]), map[string]any{"default_access": "viewer"}).Code; code != http.StatusNotFound {
		t.Fatalf("member on restricted project: %d", code)
	}

	// Everyone views; nobody loses access.
	r = f.patchDefault(t, "owner", "viewer", false)
	if r.LoseAccess != 0 || r.DefaultAccess != "viewer" || r.PreviousDefaultAccess != "none" {
		t.Fatalf("set viewer = %+v", r)
	}
	if !f.can(t, "member", authz.ProjectView) || f.can(t, "member", authz.ProjectEdit) {
		t.Fatal("viewer default: member should view only")
	}
	f.agreesWithSpiceDB(t, f.list(t, "owner", nil))
	// Setting the same value again changes nothing.
	f.patchDefault(t, "owner", "viewer", false)
	if n := f.auditCount(t, "project.access_changed"); n != 2 {
		t.Fatalf("project.access_changed events = %d", n)
	}
}

func TestProjectAccessMemberLimit(t *testing.T) {
	f := setupAccess(t)
	for _, name := range []string{"admin", "member", "member2", "viewer"}[:testMaxDirectMembers] {
		if code, body := f.putRole("owner", name, "viewer"); code != http.StatusOK {
			t.Fatalf("grant %s: %d %s", name, code, body)
		}
	}
	code, body := f.putRole("owner", "viewer2", "viewer")
	wantCode(t, "over the limit", code, body, http.StatusConflict, "member_limit_reached")
	// Changing an existing grant is not a new one.
	if code, body := f.putRole("owner", "member", "admin"); code != http.StatusOK {
		t.Fatalf("change at the limit: %d %s", code, body)
	}
	// Removing one frees a place.
	if code, _ := f.deleteRole("owner", "viewer"); code != http.StatusNoContent {
		t.Fatalf("remove: %d", code)
	}
	if code, body := f.putRole("owner", "viewer2", "viewer"); code != http.StatusOK {
		t.Fatalf("grant after removal: %d %s", code, body)
	}
}
