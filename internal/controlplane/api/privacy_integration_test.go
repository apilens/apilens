//go:build integration

package api

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestPrivacyPolicy(t *testing.T) {
	f := setupProjects(t)
	NewPrivacy(privacy.NewService(f.pool), testutil.Logger(t)).Register(f.api)
	owner := f.user(t, "pp-owner@example.com")
	member := f.user(t, "pp-member@example.com")
	viewer := f.user(t, "pp-viewer@example.com")
	stranger := f.user(t, "pp-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	p := f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	projectID := uuid.MustParse(p.ID)
	path := ProjectsPath + "/shop/privacy-policy"

	// Nothing saved yet: empty lists, the defaults, no updated_at.
	resp := f.api.Get(path, as(viewer))
	if resp.Code != http.StatusOK {
		t.Fatalf("get: %d %s", resp.Code, resp.Body)
	}
	got := decode[PrivacyPolicy](t, resp)
	if got.App != nil || len(got.MaskQueryParams) != 0 || got.UpdatedAt != nil ||
		!slices.Equal(got.Defaults.MaskBodyFields, privacy.DefaultBodyFields) || !slices.Contains(got.Defaults.SensitiveHeaders, "authorization") {
		t.Fatalf("initial = %+v", got)
	}

	// A member saves the project policy; patterns are trimmed and deduplicated.
	resp = f.api.Put(path, as(member), map[string]any{
		"mask_query_params": []string{" ^email$ ", "^email$"},
		"mask_body_fields":  []string{"^iban$"},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("put: %d %s", resp.Code, resp.Body)
	}
	got = decode[PrivacyPolicy](t, resp)
	if !slices.Equal(got.MaskQueryParams, []string{"^email$"}) || len(got.MaskHeaders) != 0 ||
		!slices.Equal(got.MaskBodyFields, []string{"^iban$"}) || got.UpdatedAt == nil {
		t.Fatalf("put = %+v", got)
	}
	if again := decode[PrivacyPolicy](t, f.api.Get(path, as(owner))); !slices.Equal(again.MaskQueryParams, got.MaskQueryParams) || !again.UpdatedAt.Equal(*got.UpdatedAt) {
		t.Fatalf("get after put = %+v", again)
	}

	// An app policy, addressed by slug (the default app is the project slug).
	resp = f.api.Put(path+"?app=shop", as(owner), map[string]any{"mask_headers": []string{"^x-tenant$"}})
	if resp.Code != http.StatusOK {
		t.Fatalf("put app: %d %s", resp.Code, resp.Body)
	}
	if got := decode[PrivacyPolicy](t, resp); got.App == nil || *got.App != "shop" || !slices.Equal(got.MaskHeaders, []string{"^x-tenant$"}) {
		t.Fatalf("app policy = %+v", got)
	}
	// Replacing it again keeps one row per scope.
	if resp := f.api.Put(path+"?app=shop", as(owner), map[string]any{"mask_headers": []string{"^x-org$"}}); resp.Code != http.StatusOK {
		t.Fatalf("re-put app: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM privacy_policies WHERE project_id = $1`, projectID); n != 2 {
		t.Fatalf("rows = %d, want 2", n)
	}

	// The edge resolver merges defaults, project and app policies.
	var appID uuid.UUID
	if err := f.pool.QueryRow(f.ctx, `SELECT id FROM apps WHERE project_id = $1 AND slug = 'shop'`, projectID).Scan(&appID); err != nil {
		t.Fatal(err)
	}
	red, err := privacy.NewResolver(db.New(f.pool), time.Minute).Redactor(f.ctx, projectID, appID)
	if err != nil {
		t.Fatal(err)
	}
	if got := red.Headers(`{"x-org":"acme","x-tenant":"t","cookie":"c"}`); got != `{"x-org":"[redacted]","x-tenant":"t","cookie":"[redacted]"}` {
		t.Fatalf("app headers = %s", got)
	}
	if got := red.RawPath("/a?email=x&token=y"); got != "/a?email=[redacted]&token=[redacted]" {
		t.Fatalf("app query = %s", got)
	}

	// Refusals.
	expectProblem(t, "viewer put", f.api.Put(path, as(viewer), map[string]any{}), http.StatusForbidden, "forbidden")
	expectProblem(t, "stranger get", f.api.Get(path, as(stranger)), http.StatusForbidden, "forbidden")
	expectProblem(t, "unknown project", f.api.Get(ProjectsPath+"/nope/privacy-policy", as(owner)), http.StatusForbidden, "forbidden")
	expectProblem(t, "unknown app", f.api.Get(path+"?app=ghost", as(owner)), http.StatusBadRequest, "invalid_request")
	expectProblem(t, "bad pattern", f.api.Put(path, as(owner), map[string]any{"mask_body_fields": []string{"ok", "pass(?=word)"}}), http.StatusBadRequest, "invalid_request")
	if resp := f.api.Get(path); resp.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", resp.Code)
	}
}
