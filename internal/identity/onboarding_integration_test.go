//go:build integration

package identity

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/apilens/apilens/internal/identity/users"
)

func TestOnboardingPatch(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "onboarding@example.com")

	patch := func(body any) (int, Onboarding) {
		t.Helper()
		resp := f.api.Patch(OnboardingPath, auth, body)
		var out Onboarding
		if resp.Code == http.StatusOK {
			if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.Code, out
	}
	stored := func() map[string]any {
		t.Helper()
		got, err := f.q.GetUserByID(f.ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(got.Onboarding, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	// The step and the first answers.
	code, got := patch(map[string]any{"step": "project", "answers": map[string]any{"org_slug": "acme"}})
	if code != http.StatusOK || got.Step == nil || *got.Step != "project" || got.Completed || got.CompletedAt != nil ||
		got.Answers.OrgSlug == nil || *got.Answers.OrgSlug != "acme" || got.Answers.ProjectSlug != nil {
		t.Fatalf("first patch = %d %+v", code, got)
	}

	// Answers merge key by key: earlier ones survive.
	code, got = patch(map[string]any{"step": "install", "answers": map[string]any{
		"project_slug": "checkout", "language": "python", "runtime": "fastapi", "method": "sdk",
	}})
	if code != http.StatusOK || *got.Step != "install" || got.Answers.OrgSlug == nil || *got.Answers.OrgSlug != "acme" ||
		*got.Answers.ProjectSlug != "checkout" || *got.Answers.Language != "python" || *got.Answers.Runtime != "fastapi" || *got.Answers.Method != "sdk" {
		t.Fatalf("second patch = %d %+v", code, got)
	}

	// Answers alone leave the step; a changed answer replaces the old one.
	code, got = patch(map[string]any{"answers": map[string]any{"language": "go", "invited": 3}})
	if code != http.StatusOK || *got.Step != "install" || *got.Answers.Language != "go" || got.Answers.Invited == nil || *got.Answers.Invited != 3 {
		t.Fatalf("answers-only patch = %d %+v", code, got)
	}

	// Concurrent patches of different answers lose nothing.
	var wg sync.WaitGroup
	for _, body := range []map[string]any{
		{"answers": map[string]any{"runtime": "gin"}},
		{"answers": map[string]any{"method": "otel"}},
		{"step": "waiting"},
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if resp := f.api.Patch(OnboardingPath, auth, body); resp.Code != http.StatusOK {
				t.Errorf("concurrent patch %v = %d", body, resp.Code)
			}
		}()
	}
	wg.Wait()
	answers, _ := stored()["answers"].(map[string]any)
	if stored()["step"] != "waiting" || answers["runtime"] != "gin" || answers["method"] != "otel" || answers["org_slug"] != "acme" {
		t.Fatalf("after concurrent patches: %v", stored())
	}

	// Completing stamps completed_at once; the context reads it as completed.
	code, got = patch(map[string]any{"completed": true})
	if code != http.StatusOK || !got.Completed || got.CompletedAt == nil {
		t.Fatalf("complete = %d %+v", code, got)
	}
	first := *got.CompletedAt
	_, got = patch(map[string]any{"completed": true, "step": "done"})
	if got.CompletedAt == nil || !got.CompletedAt.Equal(first) || *got.Step != "done" {
		t.Fatalf("second complete = %+v, want completed_at kept at %s", got, first)
	}
	if me := f.api.Get(MePath, auth); me.Code != http.StatusOK {
		t.Fatalf("me = %d", me.Code)
	}
	// Reopening clears it.
	_, got = patch(map[string]any{"completed": false})
	if got.Completed || got.CompletedAt != nil {
		t.Fatalf("reopen = %+v", got)
	}
	if _, ok := stored()["completed_at"]; ok {
		t.Fatalf("completed_at kept after reopen: %v", stored())
	}

	// Invalid input fails validation and changes nothing.
	before := stored()
	for name, body := range map[string]any{
		"unknown field":     map[string]any{"color": "red"},
		"unknown answer":    map[string]any{"answers": map[string]any{"email": "x@example.com"}},
		"bad step":          map[string]any{"step": "Not A Step"},
		"bad org slug":      map[string]any{"answers": map[string]any{"org_slug": "Acme Inc"}},
		"bad language":      map[string]any{"answers": map[string]any{"language": "Py thon"}},
		"negative invited":  map[string]any{"answers": map[string]any{"invited": -1}},
		"fraction invited":  map[string]any{"answers": map[string]any{"invited": 1.5}},
		"string completed":  map[string]any{"completed": "yes"},
		"answers not a map": map[string]any{"answers": "acme"},
	} {
		if resp := f.api.Patch(OnboardingPath, auth, body); resp.Code != http.StatusUnprocessableEntity && resp.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 422", name, resp.Code)
		}
	}
	after, _ := json.Marshal(stored())
	want, _ := json.Marshal(before)
	if string(after) != string(want) {
		t.Fatalf("invalid patches changed the state: %s -> %s", want, after)
	}

	// No session, no patch.
	if resp := f.api.Patch(OnboardingPath, map[string]any{"step": "about"}); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d", resp.Code)
	}
}

// TestOnboardingPatchKeepsDefaultStep checks a new user's stored default
// ({step: about}) survives an answers-only patch.
func TestOnboardingPatchKeepsDefaultStep(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "fresh@example.com")
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET onboarding = '{"step":"about"}' WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	resp := f.api.Patch(OnboardingPath, auth, map[string]any{"answers": map[string]any{"org_slug": "acme"}})
	var got Onboarding
	if resp.Code != http.StatusOK || json.Unmarshal(resp.Body.Bytes(), &got) != nil || got.Step == nil || *got.Step != users.OnboardingStepAbout {
		t.Fatalf("patch = %d %s", resp.Code, resp.Body.String())
	}
}

// TestOnboardingPatchDeletedUser answers session_expired for a user deleted
// while their access token is still valid.
func TestOnboardingPatchDeletedUser(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "gone@example.com")
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET deleted_at = now() WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if resp := f.api.Patch(OnboardingPath, auth, map[string]any{"step": "about"}); resp.Code != http.StatusUnauthorized {
		t.Fatalf("deleted user = %d %s", resp.Code, resp.Body.String())
	}
}
