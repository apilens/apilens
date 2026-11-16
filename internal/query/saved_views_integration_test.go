//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestSavedViews drives the saved view CRUD through the API against
// Postgres and a real SpiceDB: members create views, shared ones are read
// by every member and the read key, private ones only by their creator, and
// only the creator or a project admin changes them.
func TestSavedViews(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	admin, alice, bob, outsider := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{admin, alice, bob, outsider} {
		email := []string{"admin@example.com", "alice@example.com", "bob@example.com", "outsider@example.com"}[i]
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, email); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, seed.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", seed.ProjectID.String(), "org", "organization", seed.OrgID.String()),
		orgRoleDefault(seed.ProjectID.String(), "default_editor", seed.OrgID.String(), "member"),
		orgRoleDefault(seed.ProjectID.String(), "default_viewer", seed.OrgID.String(), "viewer"),
		touch("organization", seed.OrgID.String(), "admin", "user", admin.String()),
		touch("organization", seed.OrgID.String(), "member", "user", alice.String()),
		touch("organization", seed.OrgID.String(), "member", "user", bob.String()),
	}); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	api.UseMiddleware(func(hctx huma.Context, next func(huma.Context)) {
		if id := hctx.Header("X-Test-User"); id != "" {
			hctx = huma.WithContext(hctx, authn.WithPrincipal(hctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: uuid.MustParse(id)}))
		}
		next(hctx)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	guard := authz.NewGuard(client, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(nil, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// do sends a request as user ("" = the project read key) and decodes a
	// 2xx JSON answer into out.
	do := func(method, path string, user uuid.UUID, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if user != uuid.Nil {
			req.Header.Set("X-Test-User", user.String())
		} else {
			req.Header.Set("Authorization", "Bearer "+seed.ReadKey)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode/100 == 2 {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	type view struct {
		ID        string         `json:"id"`
		Name      string         `json:"name"`
		Surface   string         `json:"surface"`
		Filter    map[string]any `json:"filter"`
		Shared    bool           `json:"shared"`
		CreatedBy *string        `json:"created_by"`
	}
	type list struct {
		Views []view `json:"views"`
	}
	const views = "/api/v1/projects/shop/views"
	names := func(user uuid.UUID, query string) []string {
		t.Helper()
		var l list
		if code := do(http.MethodGet, views+query, user, nil, &l); code != http.StatusOK {
			t.Fatalf("list as %v: %d", user, code)
		}
		out := []string{}
		for _, v := range l.Views {
			out = append(out, v.Name)
		}
		return out
	}

	// Alice saves a shared and a private view.
	var team, mine view
	if code := do(http.MethodPost, views, alice, map[string]any{
		"name": " Checkout 5xx ", "surface": "errors", "shared": true,
		"filter": map[string]any{"status": []int{500, 502}, "path": "/checkout"},
	}, &team); code != http.StatusCreated {
		t.Fatalf("create shared: %d", code)
	}
	if team.Name != "Checkout 5xx" || !team.Shared || team.CreatedBy == nil || *team.CreatedBy != alice.String() ||
		team.Filter["path"] != "/checkout" || len(team.Filter["status"].([]any)) != 2 {
		t.Fatalf("created %+v", team)
	}
	if code := do(http.MethodPost, views, alice, map[string]any{"name": "My slow calls", "surface": "explore"}, &mine); code != http.StatusCreated {
		t.Fatalf("create private: %d", code)
	}
	if mine.Shared || len(mine.Filter) != 0 {
		t.Fatalf("created %+v", mine)
	}

	// Creation rules.
	for _, c := range []struct {
		name string
		user uuid.UUID
		body map[string]any
		want int
	}{
		{"duplicate name", alice, map[string]any{"name": "Checkout 5xx", "surface": "errors"}, http.StatusConflict},
		{"blank name", alice, map[string]any{"name": "  ", "surface": "errors"}, http.StatusUnprocessableEntity},
		{"bad surface", alice, map[string]any{"name": "x", "surface": "billing"}, http.StatusUnprocessableEntity},
		{"filter not an object", alice, map[string]any{"name": "x", "surface": "errors", "filter": []int{1}}, http.StatusUnprocessableEntity},
		{"read key", uuid.Nil, map[string]any{"name": "x", "surface": "errors"}, http.StatusUnauthorized},
		{"outsider", outsider, map[string]any{"name": "x", "surface": "errors"}, http.StatusNotFound},
	} {
		if code := do(http.MethodPost, views, c.user, c.body, nil); code != c.want {
			t.Errorf("%s: %d, want %d", c.name, code, c.want)
		}
	}
	// Bob may reuse Alice's name: names are unique per creator.
	var bobs view
	if code := do(http.MethodPost, views, bob, map[string]any{"name": "Checkout 5xx", "surface": "errors"}, &bobs); code != http.StatusCreated {
		t.Fatalf("bob create: %d", code)
	}

	// Reads: shared views for every member and the read key; private ones
	// for their creator only.
	if got := names(alice, ""); len(got) != 2 {
		t.Errorf("alice sees %v, want her own 2 and not Bob's private view", got)
	}
	if got := names(bob, ""); len(got) != 2 {
		t.Errorf("bob sees %v, want Alice's shared view and his own", got)
	}
	if got := names(uuid.Nil, ""); len(got) != 1 || got[0] != "Checkout 5xx" {
		t.Errorf("read key sees %v, want the shared view only", got)
	}
	if got := names(alice, "?surface=explore"); len(got) != 1 || got[0] != "My slow calls" {
		t.Errorf("alice explore views: %v", got)
	}
	if code := do(http.MethodGet, views, outsider, nil, nil); code != http.StatusNotFound {
		t.Errorf("outsider list: %d, want 404", code)
	}
	for _, c := range []struct {
		name string
		id   string
		user uuid.UUID
		want int
	}{
		{"member reads shared", team.ID, bob, http.StatusOK},
		{"read key reads shared", team.ID, uuid.Nil, http.StatusOK},
		{"creator reads private", mine.ID, alice, http.StatusOK},
		{"member reads private", mine.ID, bob, http.StatusNotFound},
		{"admin reads private", mine.ID, admin, http.StatusNotFound},
		{"unknown id", uuid.NewString(), alice, http.StatusNotFound},
	} {
		if code := do(http.MethodGet, views+"/"+c.id, c.user, nil, nil); code != c.want {
			t.Errorf("%s: %d, want %d", c.name, code, c.want)
		}
	}

	// Edits: the creator or a project admin.
	update := map[string]any{"name": "Checkout errors", "shared": true, "filter": map[string]any{"status": []int{500}}}
	if code := do(http.MethodPut, views+"/"+team.ID, bob, update, nil); code != http.StatusForbidden {
		t.Errorf("member edits another's shared view: %d, want 403", code)
	}
	if code := do(http.MethodPut, views+"/"+team.ID, uuid.Nil, update, nil); code != http.StatusUnauthorized {
		t.Errorf("read key edits: %d, want 401", code)
	}
	if code := do(http.MethodPut, views+"/"+mine.ID, admin, update, nil); code != http.StatusNotFound {
		t.Errorf("admin edits a private view: %d, want 404", code)
	}
	var edited view
	if code := do(http.MethodPut, views+"/"+team.ID, alice, update, &edited); code != http.StatusOK {
		t.Fatalf("creator edits: %d", code)
	}
	if edited.Name != "Checkout errors" || edited.Surface != "errors" || len(edited.Filter["status"].([]any)) != 1 {
		t.Errorf("edited %+v", edited)
	}
	var byAdmin view
	if code := do(http.MethodPut, views+"/"+team.ID, admin, map[string]any{"name": "Checkout errors (team)", "shared": true}, &byAdmin); code != http.StatusOK {
		t.Fatalf("admin edits shared: %d", code)
	}
	if byAdmin.CreatedBy == nil || *byAdmin.CreatedBy != alice.String() || len(byAdmin.Filter) != 0 {
		t.Errorf("admin edit keeps the creator and replaces the filter: %+v", byAdmin)
	}
	// Renaming onto another of the creator's names conflicts.
	if code := do(http.MethodPost, views, alice, map[string]any{"name": "Taken", "surface": "errors"}, nil); code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	if code := do(http.MethodPut, views+"/"+team.ID, alice, map[string]any{"name": "Taken"}, nil); code != http.StatusConflict {
		t.Errorf("rename onto a taken name: %d, want 409", code)
	}
	// Unsharing hides the view from others.
	if code := do(http.MethodPut, views+"/"+team.ID, alice, map[string]any{"name": "Checkout errors"}, nil); code != http.StatusOK {
		t.Fatalf("unshare: %d", code)
	}
	if code := do(http.MethodGet, views+"/"+team.ID, bob, nil, nil); code != http.StatusNotFound {
		t.Errorf("unshared view still visible to bob: %d", code)
	}

	// Deletes: the creator or a project admin.
	if code := do(http.MethodDelete, views+"/"+bobs.ID, alice, nil, nil); code != http.StatusNotFound {
		t.Errorf("alice deletes bob's private view: %d, want 404", code)
	}
	if code := do(http.MethodPut, views+"/"+bobs.ID, bob, map[string]any{"name": "Bob's", "shared": true}, nil); code != http.StatusOK {
		t.Fatalf("bob shares: %d", code)
	}
	if code := do(http.MethodDelete, views+"/"+bobs.ID, alice, nil, nil); code != http.StatusForbidden {
		t.Errorf("alice deletes bob's shared view: %d, want 403", code)
	}
	if code := do(http.MethodDelete, views+"/"+bobs.ID, admin, nil, nil); code != http.StatusNoContent {
		t.Errorf("admin deletes a shared view: %d, want 204", code)
	}
	if code := do(http.MethodDelete, views+"/"+mine.ID, alice, nil, nil); code != http.StatusNoContent {
		t.Errorf("creator deletes: %d, want 204", code)
	}
	if code := do(http.MethodDelete, views+"/"+mine.ID, alice, nil, nil); code != http.StatusNotFound {
		t.Errorf("delete twice: %d, want 404", code)
	}
	if got := names(alice, ""); len(got) != 2 {
		t.Errorf("alice sees %v after deletes, want 2", got)
	}
}
