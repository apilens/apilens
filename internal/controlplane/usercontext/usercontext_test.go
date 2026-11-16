package usercontext

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
)

// fakeChecker grants the (permission, resource) pairs in allow and records
// every CheckBulk call.
type fakeChecker struct {
	allow map[string]bool // "type:id#permission"
	err   error
	calls [][]authz.CheckItem
}

func (f *fakeChecker) CheckBulk(_ context.Context, items []authz.CheckItem) ([]bool, error) {
	f.calls = append(f.calls, items)
	out := make([]bool, len(items))
	if f.err != nil {
		return out, f.err
	}
	for i, it := range items {
		out[i] = f.allow[it.Resource.String()+"#"+string(it.Permission)]
	}
	return out, nil
}

func grant(obj authz.Resource, perms ...authz.Permission) map[string]bool {
	m := map[string]bool{}
	for _, p := range perms {
		m[obj.String()+"#"+string(p)] = true
	}
	return m
}

func TestCapabilities(t *testing.T) {
	user := uuid.New()
	acme, initech := uuid.New(), uuid.New()
	web, checkout, reports := uuid.New(), uuid.New(), uuid.New()
	orgs := []Org{
		{ID: acme, Slug: "acme", Role: "owner", Projects: []Project{{ID: web, Slug: "web"}, {ID: checkout, Slug: "checkout"}}},
		{ID: initech, Slug: "initech", Role: "viewer", Projects: []Project{{ID: reports, Slug: "reports"}}},
		{ID: uuid.New(), Slug: "empty", Role: "admin", Projects: []Project{}},
	}
	allow := map[string]bool{}
	for _, m := range []map[string]bool{
		// acme owner: everything.
		grant(authz.Organization(acme.String()), authz.OrgInvite, authz.OrgManageMembers, authz.OrgManageBilling),
		grant(authz.Project(acme.String(), web.String()), authz.ProjectView, authz.ProjectEdit, authz.ProjectDelete, authz.ProjectManageKeys, authz.ProjectManageCapture, authz.ProjectManageAlerts, authz.ProjectManageAccess, authz.ProjectViewAudit),
		grant(authz.Project(acme.String(), checkout.String()), authz.ProjectView, authz.ProjectEdit, authz.ProjectDelete, authz.ProjectManageKeys, authz.ProjectManageCapture, authz.ProjectManageAlerts, authz.ProjectManageAccess, authz.ProjectViewAudit),
		// initech viewer: view only.
		grant(authz.Project(initech.String(), reports.String()), authz.ProjectView),
	} {
		for k, v := range m {
			allow[k] = v
		}
	}
	checker := &fakeChecker{allow: allow}
	s := &Service{checker: checker}

	got, err := s.capabilities(context.Background(), user, orgs)
	if err != nil {
		t.Fatal(err)
	}
	all := []string{
		ActionProjectRead, ActionProjectUpdate, ActionProjectDelete, ActionAPIKeysCreate, ActionAPIKeysRevoke, ActionCaptureManage, ActionAlertsManage, ActionAccessManage, ActionAuditRead,
		ActionMembersInvite, ActionMembersRemove, ActionBillingManage,
	}
	want := map[string][]string{"web": all, "checkout": all, "reports": {ActionProjectRead}}
	if len(got) != len(want) {
		t.Fatalf("capabilities = %v", got)
	}
	for slug, w := range want {
		if !slices.Equal(got[slug], w) {
			t.Errorf("capabilities[%s] = %v, want %v", slug, got[slug], w)
		}
	}

	// One round trip; each (permission, resource) pair asked once: eight
	// project permissions per project, three org permissions per org that
	// has projects.
	if len(checker.calls) != 1 {
		t.Fatalf("CheckBulk calls = %d, want 1", len(checker.calls))
	}
	items := checker.calls[0]
	if len(items) != 3*8+2*3 {
		t.Fatalf("items = %d, want %d", len(items), 3*8+2*3)
	}
	seen := map[string]bool{}
	for _, it := range items {
		k := it.Resource.String() + "#" + string(it.Permission)
		if seen[k] {
			t.Errorf("asked %s twice", k)
		}
		seen[k] = true
		if it.Subject != authz.User(user.String()) {
			t.Errorf("subject = %v", it.Subject)
		}
		if it.Resource.Org != acme.String() && it.Resource.Org != initech.String() {
			t.Errorf("resource %v has org %q", it.Resource.Object, it.Resource.Org)
		}
	}
}

func TestCapabilitiesNoProjects(t *testing.T) {
	checker := &fakeChecker{}
	s := &Service{checker: checker}
	got, err := s.capabilities(context.Background(), uuid.New(), []Org{{ID: uuid.New(), Projects: []Project{}}})
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("capabilities = %v, %v", got, err)
	}
	if len(checker.calls) != 0 {
		t.Fatalf("CheckBulk called %d times without projects", len(checker.calls))
	}
}

// When SpiceDB cannot answer there are no capabilities at all (fail closed).
func TestCapabilitiesUnavailable(t *testing.T) {
	s := &Service{checker: &fakeChecker{err: authz.ErrUnavailable}}
	org := uuid.New()
	got, err := s.capabilities(context.Background(), uuid.New(), []Org{{ID: org, Projects: []Project{{ID: uuid.New(), Slug: "web"}}}})
	if !errors.Is(err, authz.ErrUnavailable) || got != nil {
		t.Fatalf("capabilities = %v, %v", got, err)
	}
}

// TestVocabulary pins the action → permission table of authz/README.md.
func TestVocabulary(t *testing.T) {
	want := []Grant{
		{"project.read", "view", false},
		{"project.update", "edit", false},
		{"project.delete", "delete", false},
		{"api_keys.create", "manage_keys", false},
		{"api_keys.revoke", "manage_keys", false},
		{"capture.manage", "manage_capture", false},
		{"alerts.manage", "manage_alerts", false},
		{"access.manage", "manage_access", false},
		{"audit.read", "view_audit", false},
		{"members.invite", "invite", true},
		{"members.remove", "manage_members", true},
		{"billing.manage", "manage_billing", true},
	}
	if !slices.Equal(Vocabulary, want) {
		t.Fatalf("Vocabulary = %v, want %v", Vocabulary, want)
	}
}

func TestLastProject(t *testing.T) {
	for raw, want := range map[string]string{
		`{"last_project_slug":"checkout","home":"requests"}`: "checkout",
		`{"home":"requests"}`:                                "",
		`{"last_project_slug":7}`:                            "",
		`not json`:                                           "",
		``:                                                   "",
	} {
		if got := lastProject([]byte(raw)); got != want {
			t.Errorf("lastProject(%s) = %q, want %q", raw, got, want)
		}
	}
}

// A project the user cannot view (a restricted project without a grant) is
// left out of the orgs, the capabilities and the last project; each kept
// project carries the effective role its actions imply.
func TestVisible(t *testing.T) {
	c := Context{
		Orgs: []Org{
			{Slug: "acme", Projects: []Project{{Slug: "admin"}, {Slug: "editor"}, {Slug: "secret"}, {Slug: "viewer"}}},
			{Slug: "initech", Projects: []Project{{Slug: "hidden"}}},
		},
		Capabilities: map[string][]string{
			"admin":  {ActionProjectRead, ActionProjectUpdate, ActionAccessManage, ActionAuditRead},
			"editor": {ActionProjectRead, ActionProjectUpdate, ActionAPIKeysCreate},
			"secret": {},
			"viewer": {ActionProjectRead, ActionMembersInvite},
			"hidden": {ActionMembersInvite},
		},
	}
	visible(&c, "secret")
	type view struct{ slug, role string }
	var got []view
	for _, o := range c.Orgs {
		for _, p := range o.Projects {
			got = append(got, view{p.Slug, p.Role})
		}
	}
	want := []view{{"admin", RoleAdmin}, {"editor", RoleEditor}, {"viewer", RoleViewer}}
	if !slices.Equal(got, want) {
		t.Fatalf("projects = %v, want %v", got, want)
	}
	if c.Orgs[1].Projects == nil || len(c.Orgs[1].Projects) != 0 {
		t.Fatalf("initech projects = %v, want empty", c.Orgs[1].Projects)
	}
	if _, ok := c.Capabilities["secret"]; ok || len(c.Capabilities) != 3 {
		t.Fatalf("capabilities = %v", c.Capabilities)
	}
	if c.LastProjectSlug != "" {
		t.Fatalf("last project = %q, want empty", c.LastProjectSlug)
	}
	visible(&c, "editor")
	if c.LastProjectSlug != "editor" {
		t.Fatalf("last project = %q, want editor", c.LastProjectSlug)
	}
}
