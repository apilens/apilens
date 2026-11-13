//go:build integration

package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// setupInvitationGrants is the access fixture (org acme, project shop,
// SpiceDB fed by the relay) with the invitation and invitation link
// endpoints; invitation emails land in river_job and are never sent.
func setupInvitationGrants(t *testing.T) *accessFixture {
	t.Helper()
	f := setupAccess(t)
	logger := testutil.Logger(t)
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(f.pool, config.JobsConfig{}, reg, time.Second, logger, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	guard := authz.NewGuard(f.authz, authz.NewPGResolver(f.pool), authz.GuardOptions{}, logger)
	svc := orgs.NewInvitations(f.pool, audit.New(f.pool), jc)
	NewInvitations(svc, logger).WithAuthorizer(guard).Register(f.api)
	NewInvitationLinks(svc, nil, ratelimit.Rate{}, logger).Register(f.api)
	return f
}

// inviteWithGrants invites addr to acme as org viewer with the project
// grants (project slug, role pairs) as caller.
func (f *accessFixture) inviteWithGrants(caller, addr string, grants ...string) *httptest.ResponseRecorder {
	list := make([]map[string]any, 0, len(grants)/2)
	for i := 0; i+1 < len(grants); i += 2 {
		list = append(list, map[string]any{"project": grants[i], "role": grants[i+1]})
	}
	body := invite(addr, "viewer")
	body["project_grants"] = list
	return f.api.Post(orgPath(InvitationsPath, "acme"), as(f.users[caller]), body)
}

func TestInvitationProjectGrantAccepted(t *testing.T) {
	f := setupInvitationGrants(t)
	// Restricted project: only org owners and admins and people added
	// directly can see it, so the invitee's access comes from the grant.
	f.setDefault(t, "none")
	f.users["invitee"] = f.user(t, "acc-invitee@example.com")

	resp := f.api.Post(orgPath(InvitationsPath, "acme"), as(f.users["owner"]), map[string]any{
		"invites":        []map[string]any{{"email": "acc-invitee@example.com", "role": "viewer"}},
		"project_grants": []map[string]any{{"project": "shop", "role": "editor"}},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("invite: %d %s", resp.Code, resp.Body)
	}
	res := decode[inviteResponse](t, resp).Results
	if len(res) != 1 || res[0].Invitation == nil || len(res[0].Invitation.ProjectGrants) != 1 {
		t.Fatalf("results = %+v", res)
	}
	want := InvitationProjectGrant{ProjectID: f.project.String(), Project: "shop", ProjectName: "Shop", Role: "editor"}
	if g := res[0].Invitation.ProjectGrants[0]; g != want {
		t.Fatalf("grant = %+v, want %+v", g, want)
	}
	inv := res[0].Invitation.ID

	// The email names the one project.
	mails := f.invitationEmails(t)
	if len(mails) != 1 || mails[0].Data["project"] != "Shop" || mails[0].Data["project_role"] != "editor" {
		t.Fatalf("emails = %+v", mails)
	}
	token, _ := mails[0].Data["token"].(string)

	// Org and project lists show the grant; only project admins see the
	// project list.
	resp = f.api.Get(orgPath(InvitationsPath, "acme"), as(f.users["owner"]))
	if list := decode[[]Invitation](t, resp); len(list) != 1 || len(list[0].ProjectGrants) != 1 || list[0].ProjectGrants[0] != want {
		t.Fatalf("org list = %d %s", resp.Code, resp.Body)
	}
	resp = f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["admin"]))
	if list := decode[[]Invitation](t, resp); len(list) != 1 || list[0].ID != inv {
		t.Fatalf("project list = %d %s", resp.Code, resp.Body)
	}
	f.grant(t, "member", "editor")
	resp = f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["member"]))
	wantCode(t, "editor lists project invitations", resp.Code, resp.Body.String(), http.StatusForbidden, "forbidden")
	resp = f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["viewer"]))
	wantCode(t, "non-viewer lists project invitations", resp.Code, resp.Body.String(), http.StatusNotFound, "not_found")

	// The public page shows the project's name only.
	resp = f.api.Get(invitationLinkPath(token))
	if resp.Code != http.StatusOK {
		t.Fatalf("lookup: %d %s", resp.Code, resp.Body)
	}
	preview := decode[InvitationPreview](t, resp)
	if len(preview.Projects) != 1 || preview.Projects[0] != (InvitationPreviewProject{Name: "Shop", Role: "editor"}) ||
		strings.Contains(resp.Body.String(), f.project.String()) || strings.Contains(resp.Body.String(), `"shop"`) {
		t.Fatalf("preview = %s", resp.Body)
	}

	if f.can(t, "invitee", authz.ProjectView) {
		t.Fatal("invitee sees the project before accepting")
	}
	resp = f.api.Post(invitationLinkPath(token)+acceptSuffix, as(f.users["invitee"]), map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("accept: %d %s", resp.Code, resp.Body)
	}
	// Membership and grant were written together, with both topics.
	if n := f.count(t, `SELECT count(*) FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'editor' AND added_by = $3`,
		f.project, f.users["invitee"], f.users["owner"]); n != 1 {
		t.Fatalf("project_members rows = %d", n)
	}
	for topic, n := range map[string]int{"membership.upserted": 1, "project_member.upserted": 1} {
		if got := f.count(t, `SELECT count(*) FROM outbox WHERE topic = $1 AND payload->>'user_id' = $2`, topic, f.users["invitee"].String()); got != n {
			t.Fatalf("%s outbox rows = %d", topic, got)
		}
	}
	if n := f.auditCount(t, "project_member.added"); n != 1 {
		t.Fatalf("project_member.added events = %d", n)
	}
	// SpiceDB has the project role.
	if !f.can(t, "invitee", authz.ProjectEdit) || f.can(t, "invitee", authz.ProjectManageAccess) {
		t.Fatal("invitee: want the editor role on the project")
	}
	resp = f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["owner"]))
	if list := decode[[]Invitation](t, resp); len(list) != 0 {
		t.Fatalf("accepted invitation still listed: %s", resp.Body)
	}
}

func TestInvitationProjectGrantForbidden(t *testing.T) {
	f := setupInvitationGrants(t)
	f.mustCreate(t, f.users["stranger"], "Beta", "beta")
	f.mustCreateProject(t, f.users["stranger"], "beta", "Blog", "blog")
	nothingCreated := func(what string) {
		t.Helper()
		if n := f.count(t, `SELECT count(*) FROM invitations`); n != 0 {
			t.Fatalf("%s: %d invitations created", what, n)
		}
		if n := f.count(t, `SELECT count(*) FROM invitation_project_grants`); n != 0 {
			t.Fatalf("%s: %d grants created", what, n)
		}
		if n := len(f.invitationEmails(t)); n != 0 {
			t.Fatalf("%s: %d emails enqueued", what, n)
		}
	}

	// An editor of the project lacks manage_access.
	resp := f.inviteWithGrants("member", "new@example.com", "shop", "viewer")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("editor: %d", resp.Code)
	}
	nothingCreated("editor")
	// One project the caller cannot manage refuses the whole request.
	resp = f.inviteWithGrants("owner", "new@example.com", "shop", "viewer", "blog", "viewer")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("project of an organization the owner is not in: %d", resp.Code)
	}
	nothingCreated("other organization")
	resp = f.inviteWithGrants("owner", "new@example.com", "ghost", "viewer")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("no such project: %d", resp.Code)
	}
	nothingCreated("no such project")
	// manage_access on a project of another organization is not enough.
	f.join(t, "acme", f.users["stranger"], "admin")
	resp = f.inviteWithGrants("stranger", "new@example.com", "blog", "viewer")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("project of another organization: %d", resp.Code)
	}
	nothingCreated("project of another organization")
}

func TestInvitationProjectGrantRevoked(t *testing.T) {
	f := setupInvitationGrants(t)
	resp := f.inviteWithGrants("owner", "new@example.com", "shop", "admin")
	if resp.Code != http.StatusOK {
		t.Fatalf("invite: %d", resp.Code)
	}
	if n := f.count(t, `SELECT count(*) FROM invitation_project_grants`); n != 1 {
		t.Fatalf("grants = %d", n)
	}
	// A replacement invitation carries only its own grants.
	if resp := f.inviteWithGrants("owner", "new@example.com"); resp.Code != http.StatusOK {
		t.Fatalf("replace: %d", resp.Code)
	}
	if n := f.count(t, `SELECT count(*) FROM invitation_project_grants`); n != 0 {
		t.Fatalf("grants after replacing = %d", n)
	}
	if mails := f.invitationEmails(t); len(mails) != 2 || mails[1].Data["project"] != "" {
		t.Fatalf("emails = %+v", mails)
	}

	if resp := f.inviteWithGrants("owner", "other@example.com", "shop", "viewer"); resp.Code != http.StatusOK {
		t.Fatalf("invite: %d", resp.Code)
	}
	list := decode[[]Invitation](t, f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["owner"])))
	if len(list) != 1 || list[0].Email != "other@example.com" {
		t.Fatalf("project invitations = %+v", list)
	}
	if resp := f.api.Delete(invitationPath("acme", list[0].ID, ""), as(f.users["owner"])); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM invitation_project_grants`); n != 0 {
		t.Fatalf("grants after revoking = %d", n)
	}
	if list := decode[[]Invitation](t, f.api.Get(ProjectsPath+"/shop/invitations", as(f.users["owner"]))); len(list) != 0 {
		t.Fatalf("revoked invitation still listed: %+v", list)
	}
}
