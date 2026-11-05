//go:build integration

package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/testutil"
)

// countingChecker counts the SpiceDB round trips the context makes.
type countingChecker struct {
	*authz.Client
	calls atomic.Int64
}

func (c *countingChecker) CheckBulk(ctx context.Context, items []authz.CheckItem) ([]bool, error) {
	c.calls.Add(1)
	return c.Client.CheckBulk(ctx, items)
}

// setupContext is setupProjects with the user context endpoint mounted too,
// its capabilities answered by the fixture's SpiceDB.
func setupContext(t *testing.T) (*orgsFixture, *countingChecker) {
	t.Helper()
	f := setupProjects(t)
	checker := &countingChecker{Client: f.authz}
	NewContext(usercontext.New(f.pool, checker), testutil.Logger(t)).Register(f.api)
	return f, checker
}

func (f *orgsFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (f *orgsFixture) userContext(t *testing.T, user uuid.UUID) UserContext {
	t.Helper()
	resp := f.api.Get(UserContextPath, as(user))
	if resp.Code != http.StatusOK {
		t.Fatalf("context: %d %s", resp.Code, resp.Body)
	}
	return decode[UserContext](t, resp)
}

func TestUserContext(t *testing.T) {
	f, checker := setupContext(t)
	ada := f.user(t, "ctx-ada@example.com")
	grace := f.user(t, "ctx-grace@example.com")
	stranger := f.user(t, "ctx-stranger@example.com")

	// ada owns acme, is a member of globex and a viewer of initech; she is
	// not in umbrella, and gone is deleted.
	f.mustCreate(t, ada, "Acme", "acme")
	f.mustCreateProject(t, ada, "acme", "Web", "web")
	f.mustCreateProject(t, ada, "acme", "Checkout", "checkout", "staging", "production")
	f.mustCreateProject(t, ada, "acme", "Retired", "retired")
	if resp := f.api.Delete(ProjectsPath+"/retired", as(ada)); resp.Code != http.StatusNoContent {
		t.Fatalf("delete project: %d %s", resp.Code, resp.Body)
	}
	f.mustCreate(t, grace, "Globex", "globex")
	f.mustCreateProject(t, grace, "globex", "Invoices API", "invoices", "prod")
	f.join(t, "globex", ada, "member")
	f.mustCreate(t, grace, "Initech", "initech")
	f.mustCreateProject(t, grace, "initech", "Reports", "reports")
	f.join(t, "initech", ada, "viewer")
	f.mustCreate(t, grace, "Umbrella", "umbrella")
	f.mustCreateProject(t, grace, "umbrella", "Secret", "secret")
	f.mustCreate(t, ada, "Gone", "gone")
	f.mustCreateProject(t, ada, "gone", "Ghost", "ghost")
	f.exec(t, `UPDATE organizations SET deleted_at = now() WHERE slug = 'gone'`)

	f.exec(t, `UPDATE users SET preferences = '{"home":"requests","last_project_slug":"checkout"}', onboarding = '{"step":"install"}' WHERE id = $1`, ada)

	before := checker.calls.Load()
	c := f.userContext(t, ada)
	// One SpiceDB round trip for the capabilities of every project.
	if n := checker.calls.Load() - before; n != 1 {
		t.Fatalf("CheckBulk calls per context = %d, want 1", n)
	}
	if c.User.ID != ada.String() || c.User.Email != "ctx-ada@example.com" || !c.User.EmailVerified ||
		c.User.Preferences.Home != "requests" || c.User.Preferences.LastProjectSlug != "checkout" {
		t.Fatalf("user = %+v", c.User)
	}
	type orgView struct {
		slug, role string
		projects   []string
	}
	var got []orgView
	for _, o := range c.Orgs {
		v := orgView{slug: o.Slug, role: o.Role}
		if _, err := uuid.Parse(o.ID); err != nil || o.Name == "" {
			t.Fatalf("org = %+v", o)
		}
		for _, p := range o.Projects {
			v.projects = append(v.projects, p.Slug)
		}
		got = append(got, v)
	}
	want := []orgView{
		{"acme", "owner", []string{"checkout", "web"}},
		{"globex", "member", []string{"invoices"}},
		{"initech", "viewer", []string{"reports"}},
	}
	if !slices.EqualFunc(got, want, func(a, b orgView) bool {
		return a.slug == b.slug && a.role == b.role && slices.Equal(a.projects, b.projects)
	}) {
		t.Fatalf("orgs = %+v, want %+v", got, want)
	}
	checkout := c.Orgs[0].Projects[0]
	if checkout.Name != "Checkout" || !slices.Equal(checkout.Environments, []string{"production", "staging"}) {
		t.Fatalf("checkout = %+v", checkout)
	}
	if web := c.Orgs[0].Projects[1]; !slices.Equal(web.Environments, []string{"production"}) {
		t.Fatalf("web = %+v", web)
	}
	if c.LastProjectSlug == nil || *c.LastProjectSlug != "checkout" {
		t.Fatalf("last_project_slug = %v", c.LastProjectSlug)
	}
	if c.Onboarding.Step == nil || *c.Onboarding.Step != "install" || c.Onboarding.Completed {
		t.Fatalf("onboarding = %+v", c.Onboarding)
	}
	// Answered by SpiceDB from the relayed memberships: owner gets every
	// action, member the project writes, viewer only project.read.
	owner := []string{
		"project.read", "project.update", "project.delete", "api_keys.create", "api_keys.revoke", "capture.manage",
		"members.invite", "members.remove", "billing.manage",
	}
	wantCaps := map[string][]string{
		"checkout": owner,
		"web":      owner,
		"invoices": {"project.read", "project.update", "api_keys.create", "api_keys.revoke"},
		"reports":  {"project.read"},
	}
	if len(c.Capabilities) != len(wantCaps) {
		t.Fatalf("capabilities = %v", c.Capabilities)
	}
	for slug, w := range wantCaps {
		if !slices.Equal(c.Capabilities[slug], w) {
			t.Errorf("capabilities[%s] = %v, want %v", slug, c.Capabilities[slug], w)
		}
	}
	if !slices.Contains(c.Capabilities["checkout"], "billing.manage") {
		t.Errorf("owner capabilities = %v", c.Capabilities["checkout"])
	}

	// A last project the user cannot see (another org's, deleted, or in a
	// deleted org) reads as null.
	for _, slug := range []string{"secret", "retired", "ghost", "missing"} {
		f.exec(t, `UPDATE users SET preferences = preferences || jsonb_build_object('last_project_slug', $2::text) WHERE id = $1`, ada, slug)
		if c := f.userContext(t, ada); c.LastProjectSlug != nil {
			t.Errorf("last_project_slug %s = %q, want null", slug, *c.LastProjectSlug)
		}
	}

	// Onboarding completes.
	f.exec(t, `UPDATE users SET onboarding = '{"step":"done","completed":true}' WHERE id = $1`, ada)
	if c := f.userContext(t, ada); !c.Onboarding.Completed {
		t.Fatalf("onboarding = %+v", c.Onboarding)
	}

	// A user without organizations gets empty collections, not nulls.
	resp := f.api.Get(UserContextPath, as(stranger))
	if resp.Code != http.StatusOK {
		t.Fatalf("stranger: %d %s", resp.Code, resp.Body)
	}
	raw := decode[map[string]any](t, resp)
	if orgs, ok := raw["orgs"].([]any); !ok || len(orgs) != 0 {
		t.Fatalf("stranger orgs = %v", raw["orgs"])
	}
	if caps, ok := raw["capabilities"].(map[string]any); !ok || len(caps) != 0 {
		t.Fatalf("stranger capabilities = %v", raw["capabilities"])
	}
	if raw["last_project_slug"] != nil {
		t.Fatalf("stranger last_project_slug = %v", raw["last_project_slug"])
	}

	// A deleted user's still-valid token answers session_expired.
	f.exec(t, `UPDATE users SET deleted_at = now() WHERE id = $1`, stranger)
	resp = f.api.Get(UserContextPath, as(stranger))
	if p := decode[problem](t, resp); resp.Code != http.StatusUnauthorized || p.Code != "session_expired" {
		t.Fatalf("deleted user: %d %s", resp.Code, resp.Body)
	}

	// No session.
	if resp := f.api.Get(UserContextPath); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", resp.Code)
	}
}

// The acceptance case of #294: an organization viewer gets only project.read,
// and a role change reaches the capabilities on the next call.
func TestUserContextViewer(t *testing.T) {
	f, checker := setupContext(t)
	owner := f.user(t, "ctx-v-owner@example.com")
	viewer := f.user(t, "ctx-v-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Web", "web")
	f.mustCreateProject(t, owner, "acme", "Checkout", "checkout")
	f.join(t, "acme", viewer, "viewer")

	before := checker.calls.Load()
	c := f.userContext(t, viewer)
	if n := checker.calls.Load() - before; n != 1 {
		t.Fatalf("CheckBulk calls per context = %d, want 1", n)
	}
	want := map[string][]string{"web": {"project.read"}, "checkout": {"project.read"}}
	if len(c.Capabilities) != len(want) {
		t.Fatalf("capabilities = %v", c.Capabilities)
	}
	for slug, w := range want {
		if !slices.Equal(c.Capabilities[slug], w) {
			t.Errorf("viewer capabilities[%s] = %v, want %v", slug, c.Capabilities[slug], w)
		}
	}

	if resp := f.api.Patch(memberPath("acme", viewer), as(owner), map[string]any{"role": "admin"}); resp.Code != http.StatusOK {
		t.Fatalf("promote: %d %s", resp.Code, resp.Body)
	}
	admin := []string{
		"project.read", "project.update", "project.delete", "api_keys.create", "api_keys.revoke", "capture.manage",
		"members.invite", "members.remove",
	}
	c = f.userContext(t, viewer)
	for slug := range want {
		if !slices.Equal(c.Capabilities[slug], admin) {
			t.Errorf("admin capabilities[%s] = %v, want %v", slug, c.Capabilities[slug], admin)
		}
	}
}

// TestUserContextLatency: 10 organizations × 10 projects (2 environments
// each) answer in under 50 ms, capabilities included. The read is four
// indexed queries and one SpiceDB CheckBulk whatever the counts; the best of
// a few runs is measured so a busy CI box does not flake.
func TestUserContextLatency(t *testing.T) {
	f, checker := setupContext(t)
	user := f.user(t, "ctx-load@example.com")
	// Noise: another user's organizations must not slow the read down.
	other := f.user(t, "ctx-other@example.com")
	for _, owner := range []uuid.UUID{user, other} {
		var rels []*v1.RelationshipUpdate
		for o := range 10 {
			org := uuid.New()
			slug := fmt.Sprintf("load-%s-%d", owner.String()[:8], o)
			f.exec(t, `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, org, slug)
			f.exec(t, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, org, owner)
			rels = append(rels, touchRel(authz.TypeOrganization, org, "admin", authz.TypeUser, owner))
			for p := range 10 {
				project := uuid.New()
				f.exec(t, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, $3, $3)`, project, org, fmt.Sprintf("%s-p%d", slug, p))
				f.exec(t, `INSERT INTO environments (id, project_id, name) VALUES ($1, $3, 'production'), ($2, $3, 'staging')`, uuid.New(), uuid.New(), project)
				rels = append(rels, touchRel(authz.TypeProject, project, "org", authz.TypeOrganization, org))
			}
		}
		// The rows bypass the outbox, so their relationships go straight
		// to SpiceDB; recording the token per org keeps the reads fresh.
		token, err := f.authz.WriteRelationships(f.ctx, "", rels)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rels {
			if r.Relationship.Resource.ObjectType == authz.TypeOrganization {
				if err := f.authz.RecordToken(f.ctx, r.Relationship.Resource.ObjectId, token); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	f.exec(t, `ANALYZE`)

	c := f.userContext(t, user) // warm the pool and plans
	if len(c.Orgs) != 10 || len(c.Capabilities) != 100 {
		t.Fatalf("orgs = %d, capabilities = %d", len(c.Orgs), len(c.Capabilities))
	}
	admin := []string{
		"project.read", "project.update", "project.delete", "api_keys.create", "api_keys.revoke", "capture.manage",
		"members.invite", "members.remove",
	}
	for slug, caps := range c.Capabilities {
		if !slices.Equal(caps, admin) {
			t.Fatalf("capabilities[%s] = %v, want %v", slug, caps, admin)
		}
	}
	before := checker.calls.Load()
	for _, o := range c.Orgs {
		if len(o.Projects) != 10 || !slices.Equal(o.Projects[0].Environments, []string{"production", "staging"}) {
			t.Fatalf("org %s = %+v", o.Slug, o.Projects)
		}
	}
	best := time.Hour
	for range 5 {
		start := time.Now()
		resp := f.api.Get(UserContextPath, as(user))
		if d := time.Since(start); d < best {
			best = d
		}
		if resp.Code != http.StatusOK {
			t.Fatalf("status = %d", resp.Code)
		}
	}
	t.Logf("best of 5: %s", best)
	if n := checker.calls.Load() - before; n != 5 {
		t.Fatalf("CheckBulk calls for 5 contexts = %d, want 5", n)
	}
	if best >= 50*time.Millisecond {
		t.Fatalf("context took %s, want < 50ms", best)
	}
}

func touchRel(resType string, resID uuid.UUID, relation, subType string, subID uuid.UUID) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: resType, ObjectId: resID.String()},
		Relation: relation,
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: subType, ObjectId: subID.String()}},
	}}
}
