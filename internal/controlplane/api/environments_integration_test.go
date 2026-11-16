//go:build integration

package api

import (
	"net/http"
	"slices"
	"testing"
)

// envNames lists the names of l in order.
func envNames(l []Environment) []string {
	out := make([]string, len(l))
	for i, e := range l {
		out[i] = e.Name
	}
	return out
}

// TestEnvironmentSettings covers the environment list, PATCH (production
// flag, colour, hidden state, position), PUT order and DELETE refused while
// the environment is in use (#787).
func TestEnvironmentSettings(t *testing.T) {
	f := setupProjects(t)
	owner := f.user(t, "es-owner@example.com")
	viewer := f.user(t, "es-viewer@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	p := f.mustCreateProject(t, owner, "acme", "Web", "web", "staging", "production", "dev")
	envs := ProjectsPath + "/web/environments"

	list := func(t *testing.T) []Environment {
		t.Helper()
		resp := f.api.Get(envs, as(viewer))
		if resp.Code != http.StatusOK {
			t.Fatalf("list: %d %s", resp.Code, resp.Body)
		}
		out := decode[EnvironmentsOutput](t, resp).Body
		if out.Max != 20 {
			t.Fatalf("max_environments = %d", out.Max)
		}
		return out.Environments
	}

	// New environments go last, in creation order; production is flagged.
	l := list(t)
	if got := envNames(l); !slices.Equal(got, []string{"staging", "production", "dev"}) {
		t.Fatalf("order = %v", got)
	}
	for i, e := range l {
		if e.Position != i || e.Source != "dashboard" || e.Hidden || e.HasData || !e.Deletable || e.Color != nil || e.LastSeenAt != nil {
			t.Fatalf("env %d = %+v", i, e)
		}
		if e.IsProduction != (e.Name == "production") {
			t.Fatalf("%s is_production = %v", e.Name, e.IsProduction)
		}
	}

	// PATCH: production flag, colour, hidden, position.
	resp := f.api.Patch(envs+"/staging", as(owner), map[string]any{"is_production": true, "color": "teal", "hidden": true, "position": 2})
	if resp.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", resp.Code, resp.Body)
	}
	e := decode[Environment](t, resp)
	if !e.IsProduction || e.Color == nil || *e.Color != "teal" || !e.Hidden || e.HiddenAt == nil || e.Position != 2 {
		t.Fatalf("patched = %+v", e)
	}
	if got := envNames(list(t)); !slices.Equal(got, []string{"production", "dev", "staging"}) {
		t.Fatalf("order after move = %v", got)
	}
	resp = f.api.Patch(envs+"/staging", as(owner), map[string]any{"color": "none", "hidden": false})
	if e := decode[Environment](t, resp); resp.Code != http.StatusOK || e.Color != nil || e.Hidden || e.HiddenAt != nil || !e.IsProduction {
		t.Fatalf("clear: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Patch(envs+"/staging", as(owner), map[string]any{"color": "#ff0000"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("hex colour: %d", resp.Code)
	}
	if resp := f.api.Patch(envs+"/nope", as(owner), map[string]any{"hidden": true}); resp.Code != http.StatusNotFound {
		t.Fatalf("unknown env: %d", resp.Code)
	}
	if resp := f.api.Patch(envs+"/dev", as(viewer), map[string]any{"hidden": true}); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer patch: %d", resp.Code)
	}

	// PUT order: named first, the rest keep their order.
	resp = f.api.Put(envs+"/order", as(owner), map[string]any{"names": []string{"staging"}})
	if resp.Code != http.StatusOK {
		t.Fatalf("order: %d %s", resp.Code, resp.Body)
	}
	if got := envNames(decode[EnvironmentsOutput](t, resp).Body.Environments); !slices.Equal(got, []string{"staging", "production", "dev"}) {
		t.Fatalf("reordered = %v", got)
	}
	for _, bad := range [][]string{{"staging", "staging"}, {"missing"}} {
		if resp := f.api.Put(envs+"/order", as(owner), map[string]any{"names": bad}); resp.Code != http.StatusBadRequest || decode[problem](t, resp).Code != "invalid_request" {
			t.Fatalf("order %v: %d %s", bad, resp.Code, resp.Body)
		}
	}
	if resp := f.api.Put(envs+"/order", as(viewer), map[string]any{"names": []string{"dev"}}); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer order: %d", resp.Code)
	}

	// DELETE is refused while the environment has data within retention, a
	// key pinned to it or a health check using it.
	f.exec(t, `UPDATE environments SET last_seen_at = now() - interval '1 day' WHERE project_id = $1 AND name = 'production'`, p.ID)
	f.exec(t, `INSERT INTO api_keys (id, project_id, name, prefix, key_hash, environments)
		VALUES (gen_random_uuid(), $1, 'staging only', 'alk_test', repeat('a', 64), ARRAY['staging'])`, p.ID)
	l = list(t)
	for _, e := range l {
		switch e.Name {
		case "production":
			if !e.HasData || e.Deletable || e.LastSeenAt == nil {
				t.Fatalf("production = %+v", e)
			}
		case "staging":
			if e.APIKeys != 1 || e.Deletable {
				t.Fatalf("staging = %+v", e)
			}
		case "dev":
			if !e.Deletable {
				t.Fatalf("dev = %+v", e)
			}
		}
	}
	for _, name := range []string{"production", "staging"} {
		resp := f.api.Delete(envs+"/"+name, as(owner))
		if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "environment_in_use" {
			t.Fatalf("delete %s: %d %s", name, resp.Code, resp.Body)
		}
	}
	// Data older than retention no longer keeps it; a revoked key neither.
	f.exec(t, `UPDATE environments SET last_seen_at = now() - interval '500 days' WHERE project_id = $1 AND name = 'production'`, p.ID)
	f.exec(t, `UPDATE api_keys SET revoked_at = now() WHERE project_id = $1`, p.ID)
	if resp := f.api.Delete(envs+"/production", as(owner)); resp.Code != http.StatusOK {
		t.Fatalf("delete old data: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Delete(envs+"/staging", as(owner)); resp.Code != http.StatusOK {
		t.Fatalf("delete after revoke: %d %s", resp.Code, resp.Body)
	}
	if got := envNames(list(t)); !slices.Equal(got, []string{"dev"}) {
		t.Fatalf("left = %v", got)
	}

	// A hidden environment that is still in use stays listed.
	f.exec(t, `UPDATE environments SET last_seen_at = now() WHERE project_id = $1 AND name = 'dev'`, p.ID)
	if resp := f.api.Patch(envs+"/dev", as(owner), map[string]any{"hidden": true}); resp.Code != http.StatusOK {
		t.Fatalf("hide: %d", resp.Code)
	}
	if resp := f.api.Delete(envs+"/dev", as(owner)); resp.Code != http.StatusConflict {
		t.Fatalf("delete hidden in use: %d", resp.Code)
	}
}
