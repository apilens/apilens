//go:build integration

package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

// appsFixture is a project with ingest keys, an edge whose resolver creates
// apps, and the app management endpoints.
type appsFixture struct {
	*keysFixture
	users    map[string]uuid.UUID
	project  uuid.UUID
	sink     *recordingSink
	resolver *catalog.AppResolver
	edge     http.Handler
}

func setupApps(t *testing.T, limits apps.Limits) *appsFixture {
	t.Helper()
	f := setupKeys(t)
	logger := testutil.Logger(t)
	resolver := catalog.NewAppResolver(db.New(f.pool), time.Minute).
		WithProvisioner(apps.NewProvisioner(f.pool, audit.New(f.pool), limits))
	guard := authz.NewGuard(f.authz, authz.NewPGResolver(f.pool), authz.GuardOptions{}, logger)
	svc := apps.NewService(f.pool, audit.New(f.pool)).OnChange(resolver.Forget)
	NewApps(svc, nil, guard, logger).Register(f.api)

	users := map[string]uuid.UUID{}
	for _, role := range []string{"owner", "admin", "member", "viewer"} {
		users[role] = f.user(t, "apps-"+role+"@example.com")
	}
	f.mustCreate(t, users["owner"], "Acme", "acme")
	f.join(t, "acme", users["admin"], "admin")
	f.join(t, "acme", users["member"], "member")
	f.join(t, "acme", users["viewer"], "viewer")
	p := f.mustCreateProject(t, users["owner"], "acme", "Shop", "shop")

	sink := &recordingSink{}
	edge := ingest.New(f.verifier, resolver, sink, config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000},
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil).WithKeyApps(db.New(f.pool))
	mux := http.NewServeMux()
	edge.Register(mux)
	return &appsFixture{keysFixture: f, users: users, project: uuid.MustParse(p.ID), sink: sink, resolver: resolver, edge: mux}
}

// send posts one request record per app identifier (nil: one record without
// app_id) with key.
func (f *appsFixture) send(key string, appIDs ...*string) *httptest.ResponseRecorder {
	ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	var recs []string
	for i, id := range appIDs {
		app := ""
		if id != nil {
			b, _ := json.Marshal(*id)
			app = `"app_id":` + string(b) + `,`
		}
		recs = append(recs, fmt.Sprintf(`{%s"timestamp":%q,"method":"GET","path":"/r%d","status_code":200}`, app, ts, i))
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(`{"requests":[`+strings.Join(recs, ",")+`]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", key)
	rec := httptest.NewRecorder()
	f.edge.ServeHTTP(rec, req)
	return rec
}

func s(v string) *string { return &v }

func (f *appsFixture) appID(t *testing.T, slug string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(f.ctx, `SELECT id FROM apps WHERE project_id = $1 AND slug = $2 AND deleted_at IS NULL`, f.project, slug).Scan(&id); err != nil {
		t.Fatalf("app %s: %v", slug, err)
	}
	return id
}

func (f *appsFixture) listApps(t *testing.T, role string) map[string]ManagedApp {
	t.Helper()
	resp := f.api.Get(ProjectsPath+"/shop/apps", as(f.users[role]))
	if resp.Code != http.StatusOK {
		t.Fatalf("list apps as %s: %d %s", role, resp.Code, resp.Body)
	}
	out := map[string]ManagedApp{}
	for _, a := range decode[struct {
		Apps []ManagedApp `json:"apps"`
	}](t, resp).Apps {
		out[a.Slug+"/"+a.State] = a
	}
	return out
}

func appPath(id uuid.UUID, suffix string) string {
	return ProjectsPath + "/shop/apps/" + id.String() + suffix
}

func TestAppsComeFromTheSDK(t *testing.T) {
	f := setupApps(t, apps.Limits{MaxApps: 50, MaxNewPerHour: 10})
	owner := f.users["owner"]
	key := f.mustCreateKey(t, owner, "shop", "prod-backend", "ingest")
	if !key.CanCreateApps || key.AppIDs != nil {
		t.Fatalf("new keys may create apps for every app: %+v", key.APIKey)
	}

	// An unknown app name creates the app; "Orders API" and "orders-api" are one app.
	if rec := f.send(key.Key, s("Orders API")); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1}` {
		t.Fatalf("auto-create: %d %s", rec.Code, rec.Body)
	}
	orders := f.appID(t, "orders-api")
	if rec := f.send(key.Key, s("orders-api"), s(" ORDERS_api ")); rec.Code != http.StatusOK {
		t.Fatalf("same app: %d %s", rec.Code, rec.Body)
	}
	var name, createdBy string
	var keyID *uuid.UUID
	var firstSeen *time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT name, created_by, created_by_key_id, first_seen_at FROM apps WHERE id = $1`, orders).
		Scan(&name, &createdBy, &keyID, &firstSeen); err != nil {
		t.Fatal(err)
	}
	if name != "Orders API" || createdBy != "sdk" || keyID == nil || keyID.String() != key.ID || firstSeen == nil {
		t.Fatalf("origin = %q %q %v %v", name, createdBy, keyID, firstSeen)
	}
	if n := f.count(t, `SELECT count(*) FROM apps WHERE project_id = $1`, f.project); n != 2 {
		t.Fatalf("apps = %d, want shop + orders-api", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'app.created' AND metadata->>'slug' = 'orders-api' AND metadata->>'created_by' = 'sdk'`); n != 1 {
		t.Fatalf("app.created audits = %d", n)
	}
	for _, r := range f.sink.requests {
		if r.AppID != orders {
			t.Fatalf("row app %s, want %s", r.AppID, orders)
		}
	}

	// No app_id: the project's default app.
	f.sink.requests = nil
	if rec := f.send(key.Key, nil); rec.Code != http.StatusOK || len(f.sink.requests) != 1 || f.sink.requests[0].AppID != f.appID(t, "shop") {
		t.Fatalf("default app: %d %s %+v", rec.Code, rec.Body, f.sink.requests)
	}

	// Concurrent batches naming the same new app create it once.
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = f.send(key.Key, s("Race App")).Code
		}()
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("race %d: %d", i, c)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM apps WHERE project_id = $1 AND slug = 'race-app'`, f.project); n != 1 {
		t.Fatalf("race-app rows = %d", n)
	}

	// The Apps page: origin, new, last seen (key usage is written off the request path).
	deadline := time.Now().Add(5 * time.Second)
	for f.count(t, `SELECT count(*) FROM api_key_apps WHERE key_id = $1`, uuid.MustParse(key.ID)) < 3 {
		if time.Now().After(deadline) {
			t.Fatal("key usage not recorded")
		}
		time.Sleep(50 * time.Millisecond)
	}
	list := f.listApps(t, "viewer")
	o := list["orders-api/active"]
	if o.CreatedBy != "sdk" || o.CreatedByKeyName == nil || *o.CreatedByKeyName != "prod-backend" || !o.New || o.LastSeenAt == nil {
		t.Fatalf("orders-api = %+v", o)
	}
	if shop := list["shop/active"]; shop.CreatedBy != "dashboard" || shop.New || !shop.IsDefault {
		t.Fatalf("shop = %+v", shop)
	}
	keys := decode[[]APIKey](t, f.api.Get(ProjectsPath+"/shop/api-keys", as(f.users["viewer"])))
	if len(keys) != 1 || len(keys[0].AppsSeen) != 3 {
		t.Fatalf("apps seen = %+v", keys)
	}

	// Acknowledge: members cannot, admins can.
	if resp := f.api.Post(appPath(orders, "/acknowledge"), as(f.users["member"]), map[string]any{}); resp.Code != http.StatusForbidden {
		t.Fatalf("member acknowledge: %d", resp.Code)
	}
	if resp := f.api.Post(appPath(orders, "/acknowledge"), as(f.users["admin"]), map[string]any{}); resp.Code != http.StatusNoContent {
		t.Fatalf("acknowledge: %d %s", resp.Code, resp.Body)
	}
	if f.listApps(t, "viewer")["orders-api/active"].New {
		t.Fatal("acknowledged app still new")
	}

	// Archive, then data un-archives it and audits it.
	if resp := f.api.Post(appPath(orders, "/archive"), as(f.users["viewer"]), map[string]any{}); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer archive: %d", resp.Code)
	}
	if resp := f.api.Post(appPath(orders, "/archive"), as(owner), map[string]any{}); resp.Code != http.StatusNoContent {
		t.Fatalf("archive: %d %s", resp.Code, resp.Body)
	}
	if _, ok := f.listApps(t, "viewer")["orders-api/archived"]; !ok {
		t.Fatal("not archived")
	}
	if resp := f.api.Post(appPath(f.appID(t, "shop"), "/archive"), as(owner), map[string]any{}); resp.Code != http.StatusBadRequest {
		t.Fatalf("archive default app: %d", resp.Code)
	}
	if rec := f.send(key.Key, s("orders-api")); rec.Code != http.StatusOK {
		t.Fatalf("archived app data: %d %s", rec.Code, rec.Body)
	}
	if _, ok := f.listApps(t, "viewer")["orders-api/active"]; !ok {
		t.Fatal("data did not un-archive the app")
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'app.restored' AND metadata->>'by' = 'sdk'`); n != 1 {
		t.Fatalf("app.restored by sdk = %d", n)
	}

	// Merge a typo into orders-api: future data for it lands in orders-api.
	if rec := f.send(key.Key, s("ordrs-api")); rec.Code != http.StatusOK {
		t.Fatal(rec.Body)
	}
	typo := f.appID(t, "ordrs-api")
	if resp := f.api.Post(appPath(typo, "/merge"), as(owner), map[string]any{"into": orders.String()}); resp.Code != http.StatusNoContent {
		t.Fatalf("merge: %d %s", resp.Code, resp.Body)
	}
	f.sink.requests = nil
	if rec := f.send(key.Key, s("ordrs-api"), s(typo.String())); rec.Code != http.StatusOK || f.sink.requests[0].AppID != orders || f.sink.requests[1].AppID != orders {
		t.Fatalf("alias routing: %d %s %+v", rec.Code, rec.Body, f.sink.requests)
	}
	if m := f.listApps(t, "viewer")["ordrs-api/merged"]; m.MergedIntoSlug == nil || *m.MergedIntoSlug != "orders-api" {
		t.Fatalf("merged = %+v", m)
	}

	// Delete: the slug stays reserved for 30 days, then may be reused.
	race := f.appID(t, "race-app")
	if resp := f.api.Delete(appPath(race, ""), as(owner)); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	rec := f.send(key.Key, s("Race App"))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "app race-app was deleted on") || !strings.Contains(rec.Body.String(), "restore it from Apps") {
		t.Fatalf("deleted app: %d %s", rec.Code, rec.Body)
	}
	if d := f.listApps(t, "viewer")["race-app/deleted"]; d.RestorableUntil == nil {
		t.Fatalf("deleted = %+v", d)
	}
	f.exec(t, `UPDATE apps SET deleted_at = now() - interval '31 days' WHERE id = $1`, race)
	f.resolver.Forget(f.project)
	if rec := f.send(key.Key, s("Race App")); rec.Code != http.StatusOK {
		t.Fatalf("after 30 days: %d %s", rec.Code, rec.Body)
	}
	if f.appID(t, "race-app") == race {
		t.Fatal("a new app should take the slug")
	}
}

func TestAppKeyPermissionsAndScope(t *testing.T) {
	f := setupApps(t, apps.Limits{MaxApps: 50, MaxNewPerHour: 10})
	owner := f.users["owner"]
	shop := f.appID(t, "shop")

	// A key that cannot create apps: unknown apps are rejected by name, the rest of the batch is stored.
	resp := f.createKey(owner, "shop", map[string]any{"name": "ci", "scopes": []string{"ingest"}, "can_create_apps": false})
	if resp.Code != http.StatusCreated {
		t.Fatal(resp.Body)
	}
	locked := decode[CreatedAPIKey](t, resp)
	if locked.CanCreateApps || strings.Contains(strings.Join(locked.Scopes, ","), "apps:create") {
		t.Fatalf("locked = %+v", locked.APIKey)
	}
	rec := f.send(locked.Key, s("new-svc"))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `app \"new-svc\" does not exist`) || !strings.Contains(rec.Body.String(), "cannot create apps") {
		t.Fatalf("no permission: %d %s", rec.Code, rec.Body)
	}
	rec = f.send(locked.Key, s("shop"), s("new-svc"))
	var partial struct {
		Accepted int `json:"accepted"`
		Rejected []struct {
			AppID   string `json:"app_id"`
			Records int    `json:"records"`
			Error   string `json:"error"`
		} `json:"rejected"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &partial); err != nil || rec.Code != http.StatusOK || partial.Accepted != 1 ||
		len(partial.Rejected) != 1 || partial.Rejected[0].Error != "app_create_forbidden" {
		t.Fatalf("partial: %d %s", rec.Code, rec.Body)
	}

	// Turning the permission on applies to the next request (the verifier forgets the key).
	resp = f.api.Put(ProjectsPath+"/shop/api-keys/"+locked.ID+"/access", as(owner), map[string]any{"can_create_apps": true, "app_ids": nil})
	if resp.Code != http.StatusOK || !decode[APIKey](t, resp).CanCreateApps {
		t.Fatalf("update: %d %s", resp.Code, resp.Body)
	}
	time.Sleep(200 * time.Millisecond) // invalidation over Valkey
	if rec := f.send(locked.Key, s("new-svc")); rec.Code != http.StatusOK {
		t.Fatalf("after update: %d %s", rec.Code, rec.Body)
	}
	if resp := f.api.Put(ProjectsPath+"/shop/api-keys/"+locked.ID+"/access", as(f.users["viewer"]), map[string]any{"can_create_apps": false, "app_ids": nil}); resp.Code != http.StatusForbidden {
		t.Fatalf("viewer update: %d", resp.Code)
	}

	// A key limited to some apps: other apps and new apps are rejected.
	newSvc := f.appID(t, "new-svc")
	resp = f.createKey(owner, "shop", map[string]any{"name": "team-a", "scopes": []string{"ingest"}, "app_ids": []string{newSvc.String()}})
	if resp.Code != http.StatusCreated {
		t.Fatal(resp.Body)
	}
	scoped := decode[CreatedAPIKey](t, resp)
	if scoped.CanCreateApps || len(scoped.AppIDs) != 1 {
		t.Fatalf("scoped = %+v", scoped.APIKey)
	}
	if rec := f.send(scoped.Key, s("new-svc")); rec.Code != http.StatusOK {
		t.Fatalf("in scope: %d %s", rec.Code, rec.Body)
	}
	if rec := f.send(scoped.Key, s("shop")); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "app_not_allowed") {
		t.Fatalf("out of scope: %d %s", rec.Code, rec.Body)
	}
	if rec := f.send(scoped.Key, s("another")); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "limited to some apps") {
		t.Fatalf("scoped create: %d %s", rec.Code, rec.Body)
	}
	if rec := f.send(scoped.Key, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("default app is out of scope: %d %s", rec.Code, rec.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM apps WHERE project_id = $1 AND slug = 'another'`, f.project); n != 0 {
		t.Fatal("scoped key created an app")
	}
	// An app id of another project is refused.
	if resp := f.createKey(owner, "shop", map[string]any{"name": "bad", "scopes": []string{"ingest"}, "app_ids": []string{uuid.NewString()}}); resp.Code != http.StatusBadRequest {
		t.Fatalf("foreign app id: %d", resp.Code)
	}
	_ = shop
}

func TestAppLimits(t *testing.T) {
	f := setupApps(t, apps.Limits{MaxApps: 4, MaxNewPerHour: 2})
	key := f.mustCreateKey(t, f.users["owner"], "shop", "prod", "ingest")

	if rec := f.send(key.Key, s("one"), s("two")); rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// The hourly cap: the new app is rejected, the rest of the batch is stored.
	rec := f.send(key.Key, s("three"), s("one"))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"error":"app_rate_limit"`) || !strings.Contains(rec.Body.String(), `"accepted":1`) {
		t.Fatalf("hourly: %d %s", rec.Code, rec.Body)
	}
	if rec := f.send(key.Key, s("three")); rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "max_new_apps_per_hour") {
		t.Fatalf("hourly alone: %d %s", rec.Code, rec.Body)
	}

	// The project cap (shop, one, two, plus one more = 4).
	f.exec(t, `UPDATE apps SET created_at = now() - interval '2 hours' WHERE project_id = $1`, f.project)
	f.resolver.Forget(f.project)
	if rec := f.send(key.Key, s("three")); rec.Code != http.StatusOK {
		t.Fatalf("under the cap: %d %s", rec.Code, rec.Body)
	}
	f.exec(t, `UPDATE apps SET created_at = now() - interval '2 hours' WHERE project_id = $1`, f.project)
	f.resolver.Forget(f.project)
	rec = f.send(key.Key, s("four"))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "already has 4 apps") {
		t.Fatalf("project cap: %d %s", rec.Code, rec.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM apps WHERE project_id = $1`, f.project); n != 4 {
		t.Fatalf("apps = %d", n)
	}
}
