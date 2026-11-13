//go:build integration

package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestSensitiveOperationsNeedRecentSignIn runs every operation guarded by
// authz.RequireRecentAuth with a session that signed in 11 minutes ago
// (refused with reauth_required, nothing changed) and with a fresh one
// (allowed).
func TestSensitiveOperationsNeedRecentSignIn(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "ra-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	p := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	stale := signedIn(11 * time.Minute)

	t.Run("create-api-key", func(t *testing.T) {
		body := map[string]any{"name": "CI", "scopes": []string{"ingest"}}
		path := ProjectsPath + "/shop/api-keys"
		resp := f.api.Post(path, as(owner), stale, body)
		if resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "reauth_required" {
			t.Fatalf("stale: %d %s", resp.Code, resp.Body)
		}
		if n := f.count(t, `SELECT count(*) FROM api_keys WHERE project_id = $1`, p.ID); n != 0 {
			t.Fatalf("stale session created %d keys", n)
		}
		if resp := f.api.Post(path, as(owner), signedIn(9*time.Minute), body); resp.Code != http.StatusCreated {
			t.Fatalf("fresh: %d %s", resp.Code, resp.Body)
		}
	})

	t.Run("delete-project", func(t *testing.T) {
		resp := f.api.Delete(ProjectsPath+"/shop", as(owner), stale, map[string]any{"confirm": "shop"})
		if resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "reauth_required" {
			t.Fatalf("stale: %d %s", resp.Code, resp.Body)
		}
		if n := f.count(t, `SELECT count(*) FROM projects WHERE id = $1 AND deleted_at IS NULL`, p.ID); n != 1 {
			t.Fatal("stale session deleted the project")
		}
		if resp := f.api.Delete(ProjectsPath+"/shop", as(owner), map[string]any{"confirm": "shop"}); resp.Code != http.StatusOK {
			t.Fatalf("fresh: %d %s", resp.Code, resp.Body)
		}
	})
}

// TestSensitiveActionMaxAgeIsConfigurable checks the configured age
// replaces the 10-minute default.
func TestSensitiveActionMaxAgeIsConfigurable(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	NewProjects(projects.New(f.pool), f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, testutil.Logger(t)).WithRecentAuth(time.Hour).Register(f.api)
	owner := f.user(t, "ra-cfg@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")

	if resp := f.api.Delete(ProjectsPath+"/shop", as(owner), signedIn(61*time.Minute), map[string]any{"confirm": "shop"}); resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "reauth_required" {
		t.Fatalf("61m: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Delete(ProjectsPath+"/shop", as(owner), signedIn(30*time.Minute), map[string]any{"confirm": "shop"}); resp.Code != http.StatusOK {
		t.Fatalf("30m: %d %s", resp.Code, resp.Body)
	}
}
