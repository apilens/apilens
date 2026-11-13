package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeRoles grants the permissions in perms per project id and counts calls.
type fakeRoles struct {
	perms map[string][]authz.Permission
	err   error
	calls int
}

func (f *fakeRoles) CheckBulk(_ context.Context, items []authz.CheckItem) ([]bool, error) {
	f.calls++
	if f.err != nil {
		return make([]bool, len(items)), f.err
	}
	out := make([]bool, len(items))
	for i, it := range items {
		for _, p := range f.perms[it.Resource.ID] {
			if p == it.Permission {
				out[i] = true
			}
		}
	}
	return out, nil
}

func TestProjectRoles(t *testing.T) {
	var ps []projects.Project
	want := []string{}
	roles := &fakeRoles{perms: map[string][]authz.Permission{}}
	grants := [][]authz.Permission{
		{authz.ProjectView, authz.ProjectEdit, authz.ProjectManageAccess},
		{authz.ProjectView, authz.ProjectEdit},
		{authz.ProjectView},
		nil,
	}
	names := []string{"admin", "editor", "viewer", ""}
	// More projects than one bulk call holds.
	for i := range 250 {
		p := projects.Project{ID: uuid.New(), OrgID: uuid.New()}
		ps = append(ps, p)
		roles.perms[p.ID.String()] = grants[i%4]
		want = append(want, names[i%4])
	}
	got, err := projectRoles(context.Background(), roles, uuid.New(), ps)
	if err != nil {
		t.Fatal(err)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("project %d: role %q, want %q", i, got[i], want[i])
		}
	}
	if roles.calls != 3 {
		t.Fatalf("CheckBulk calls = %d, want 3", roles.calls)
	}

	if _, err := projectRoles(context.Background(), nil, uuid.New(), ps[:1]); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("nil checker: %v", err)
	}
	down := &fakeRoles{err: authz.ErrUnavailable}
	if _, err := projectRoles(context.Background(), down, uuid.New(), ps[:1]); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("down: %v", err)
	}
}

// TestProjectOperationsFailClosedWithoutGuard mounts the project, API key
// and privacy operations with no guard: every one answers 503
// authz_unavailable without reaching its service (nil here).
func TestProjectOperationsFailClosedWithoutGuard(t *testing.T) {
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	user := uuid.New()
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user})))
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	NewProjects(nil, nil, nil, nil, ratelimit.Rate{}, logger).Register(api)
	NewAPIKeys(nil, nil, logger).Register(api)
	NewPrivacy(nil, nil, logger).Register(api)

	shop := ProjectsPath + "/shop"
	for name, resp := range map[string]*httptest.ResponseRecorder{
		"list-projects":      api.Get(OrgsPath + "/acme/projects"),
		"create-project":     api.Post(OrgsPath+"/acme/projects", map[string]any{"name": "Shop", "slug": "shop"}),
		"get-project":        api.Get(shop),
		"update-project":     api.Patch(shop, map[string]any{"name": "X"}),
		"add-environment":    api.Post(shop+"/environments", map[string]any{"name": "qa"}),
		"remove-environment": api.Delete(shop + "/environments/qa"),
		"list-environments":  api.Get(shop + "/environments"),
		"update-environment": api.Patch(shop+"/environments/qa", map[string]any{"hidden": true}),
		"order-environments": api.Put(shop+"/environments/order", map[string]any{"names": []string{"qa"}}),
		"list-api-keys":      api.Get(shop + "/api-keys"),
		"revoke-api-key":     api.Delete(shop + "/api-keys/" + uuid.NewString()),
		"get-privacy-policy": api.Get(shop + "/privacy-policy"),
		"put-privacy-policy": api.Put(shop+"/privacy-policy", map[string]any{}),
	} {
		r := resp.Result()
		var p struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		if r.StatusCode != http.StatusServiceUnavailable || p.Code != "authz_unavailable" {
			t.Errorf("%s: %d %q, want 503 authz_unavailable", name, r.StatusCode, p.Code)
		}
	}
}
