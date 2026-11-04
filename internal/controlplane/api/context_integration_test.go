//go:build integration

package api

import (
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/testutil"
)

// setupContext is setupProjects with the user context endpoint mounted too.
func setupContext(t *testing.T) *orgsFixture {
	t.Helper()
	f := setupProjects(t)
	NewContext(usercontext.New(f.pool), testutil.Logger(t)).Register(f.api)
	return f
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
	f := setupContext(t)
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

	c := f.userContext(t, ada)
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
	wantCaps := map[string][]string{
		"checkout": usercontext.Actions("owner"),
		"web":      usercontext.Actions("owner"),
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

// TestUserContextLatency: 10 organizations × 10 projects (2 environments
// each) answer in under 50 ms. The read is four indexed queries whatever the
// counts; the best of a few runs is measured so a busy CI box does not flake.
func TestUserContextLatency(t *testing.T) {
	f := setupContext(t)
	user := f.user(t, "ctx-load@example.com")
	// Noise: another user's organizations must not slow the read down.
	other := f.user(t, "ctx-other@example.com")
	for _, owner := range []uuid.UUID{user, other} {
		for o := range 10 {
			org := uuid.New()
			slug := fmt.Sprintf("load-%s-%d", owner.String()[:8], o)
			f.exec(t, `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $2)`, org, slug)
			f.exec(t, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, org, owner)
			for p := range 10 {
				project := uuid.New()
				f.exec(t, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, $3, $3)`, project, org, fmt.Sprintf("%s-p%d", slug, p))
				f.exec(t, `INSERT INTO environments (id, project_id, name) VALUES ($1, $3, 'production'), ($2, $3, 'staging')`, uuid.New(), uuid.New(), project)
			}
		}
	}
	f.exec(t, `ANALYZE`)

	c := f.userContext(t, user) // warm the pool and plans
	if len(c.Orgs) != 10 || len(c.Capabilities) != 100 {
		t.Fatalf("orgs = %d, capabilities = %d", len(c.Orgs), len(c.Capabilities))
	}
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
	if best >= 50*time.Millisecond {
		t.Fatalf("context took %s, want < 50ms", best)
	}
}
