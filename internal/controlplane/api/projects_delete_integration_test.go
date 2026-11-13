//go:build integration

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// deletionGrace is project.deletion_grace in these tests.
const deletionGrace = 7 * 24 * time.Hour

// setupDeletion is the project roles fixture (org acme, project shop
// restricted with an admin, an editor and a viewer added directly) with the
// projects service wired as the api role runs it: audited, with the
// deletion grace and the key cache invalidation through Valkey to an
// edge-style verifier.
func setupDeletion(t *testing.T) *projectRolesFixture {
	t.Helper()
	f := setupOrgs(t, ratelimit.Rate{})
	logger := testutil.Logger(t)
	vcfg := testutil.Valkey(t)
	vk, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	publish := func(ctx context.Context, hash string) error {
		return cache.Publish(ctx, vk, apikeys.InvalidateChannel, hash)
	}
	svc := projects.New(f.pool).WithAudit(audit.New(f.pool)).WithDeletion(deletionGrace, publish, logger)
	NewProjects(svc, f.projectGuard(t), f.authz, nil, ratelimit.Rate{}, logger).Register(f.api)
	NewAPIKeys(apikeys.NewService(f.pool, audit.New(f.pool), publish, logger), f.projectGuard(t), logger).Register(f.api)

	v := apikeys.NewVerifier(db.New(f.pool), apikeys.Options{Size: 100, TTL: keyCacheTTL, NegativeTTL: keyCacheTTL}, logger, nil)
	sub, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sub.Close)
	ctx, cancel := context.WithCancel(f.ctx)
	t.Cleanup(cancel)
	go cache.Subscribe(ctx, sub, logger, apikeys.InvalidateChannel, v.Invalidate)
	time.Sleep(200 * time.Millisecond) // let SUBSCRIBE land
	kf := &keysFixture{orgsFixture: f, verifier: v}

	users := map[string]uuid.UUID{}
	for _, name := range []string{"owner", "orgadmin", "admin", "editor", "viewer", "outsider"} {
		users[name] = f.user(t, "del-"+name+"@example.com")
	}
	org := f.mustCreate(t, users["owner"], "Acme", "acme")
	f.join(t, "acme", users["orgadmin"], "admin")
	f.join(t, "acme", users["admin"], "member")
	f.join(t, "acme", users["editor"], "viewer")
	f.join(t, "acme", users["viewer"], "member")
	f.join(t, "acme", users["outsider"], "member")
	p := f.mustCreateProject(t, users["owner"], "acme", "Shop", "shop", "production", "staging")
	rf := &projectRolesFixture{keysFixture: kf, org: uuid.MustParse(org.ID), project: uuid.MustParse(p.ID), users: users}
	rf.restrict(t)
	for _, role := range []string{"admin", "editor", "viewer"} {
		rf.grant(t, role, role)
	}
	return rf
}

// ingestWith returns a function that sends one request event to an edge
// using f's verifier with key and answers the response.
func (f *projectRolesFixture) ingestWith(key string) func() *httptest.ResponseRecorder {
	apps := catalog.NewAppResolver(db.New(f.pool), time.Minute).WithProvisioner(appsvc.NewProvisioner(f.pool, nil, appsvc.Limits{}))
	edge := ingest.New(f.verifier, apps, &recordingSink{}, config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000},
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	mux := http.NewServeMux()
	edge.Register(mux)
	return func() *httptest.ResponseRecorder {
		ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
		body := `{"requests":[{"app_id":"shop","timestamp":"` + ts +
			`","method":"GET","path":"/orders/{id}","status_code":200,"response_time_ms":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", key)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
}

// ingestAnswers waits, for less than a key cache cycle, until send answers
// status with a body containing want.
func ingestAnswers(t *testing.T, what string, send func() *httptest.ResponseRecorder, status int, want string) {
	t.Helper()
	start := time.Now()
	for {
		rec := send()
		if rec.Code == status && strings.Contains(rec.Body.String(), want) {
			return
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("ingest %s: %d %s, want %d with %s", what, rec.Code, rec.Body, status, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// accessView is what each person sees of the project: the status of
// GET /projects/shop and the role it answers.
func (f *projectRolesFixture) accessView(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for name, id := range f.users {
		resp := f.api.Get(ProjectsPath+"/shop", as(id))
		switch resp.Code {
		case http.StatusOK:
			out[name] = decode[Project](t, resp).Role
		default:
			out[name] = http.StatusText(resp.Code)
		}
	}
	return out
}

func TestDeleteProjectSchedulesPurgeAndRestoreBringsItBack(t *testing.T) {
	f := setupDeletion(t)
	owner, orgAdmin, admin := f.users["owner"], f.users["orgadmin"], f.users["admin"]
	key := f.mustCreateKey(t, owner, "shop", "Ingest", "ingest")
	send := f.ingestWith(key.Key)
	if rec := send(); rec.Code != http.StatusOK {
		t.Fatalf("ingest before delete: %d %s", rec.Code, rec.Body)
	}
	before := f.accessView(t)
	want := map[string]string{"owner": "admin", "orgadmin": "admin", "admin": "admin", "editor": "editor", "viewer": "viewer", "outsider": "Not Found"}
	for name, role := range want {
		if before[name] != role {
			t.Fatalf("access before delete = %v, want %v", before, want)
		}
	}
	shop := ProjectsPath + "/shop"
	deleted := OrgsPath + "/acme/projects/deleted"
	restore := OrgsPath + "/acme/projects/" + f.project.String() + "/restore"

	// A wrong confirmation changes nothing.
	for _, confirm := range []string{"", "shopp", "Shop"} {
		resp := f.api.Delete(shop, as(admin), map[string]any{"confirm": confirm})
		if resp.Code != http.StatusUnprocessableEntity || decode[problem](t, resp).Code != "confirmation_mismatch" {
			t.Fatalf("confirm %q: %d %s", confirm, resp.Code, resp.Body)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM projects WHERE id = $1 AND deleted_at IS NULL AND purge_after IS NULL`, f.project); n != 1 {
		t.Fatal("a wrong confirmation deleted the project")
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'project.deleted'`); n != 0 {
		t.Fatalf("a wrong confirmation emitted %d project.deleted rows", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.deleted'`); n != 0 {
		t.Fatalf("a wrong confirmation audited %d deletions", n)
	}
	if rec := send(); rec.Code != http.StatusOK {
		t.Fatalf("ingest after a refused delete: %d %s", rec.Code, rec.Body)
	}

	// Delete: scheduled for purge after the grace period.
	start := time.Now()
	resp := f.api.Delete(shop, as(admin), map[string]any{"confirm": "shop"})
	if resp.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	got := decode[DeletedProject](t, resp)
	if got.ID != f.project.String() || got.Slug != "shop" {
		t.Fatalf("deleted = %+v", got)
	}
	if d := got.PurgeAfter.Sub(start); d < deletionGrace-time.Minute || d > deletionGrace+time.Minute {
		t.Fatalf("purge_after %s is %s after the delete, want %s", got.PurgeAfter, d, deletionGrace)
	}
	var target, changes string
	if err := f.pool.QueryRow(f.ctx, `SELECT target_id, changes::text FROM audit_events WHERE event = 'project.deleted' AND project_id = $1 AND actor_user_id = $2`,
		f.project, admin).Scan(&target, &changes); err != nil {
		t.Fatalf("project.deleted audit: %v", err)
	}
	if target != f.project.String() || !strings.Contains(changes, "purge_after") || !strings.Contains(changes, got.PurgeAfter.UTC().Format(time.RFC3339)) {
		t.Fatalf("project.deleted audit target %s changes %s", target, changes)
	}

	// Gone for everyone, ingest refused at once, slug kept.
	for name, id := range f.users {
		if resp := f.api.Get(shop, as(id)); resp.Code != http.StatusNotFound {
			t.Errorf("get deleted as %s: %d", name, resp.Code)
		}
		if list := decode[[]Project](t, f.api.Get(OrgsPath+"/acme/projects", as(id))); len(list) != 0 {
			t.Errorf("list as %s after delete = %+v", name, list)
		}
	}
	// The invalidation reaches the edge through Valkey: well within a cache
	// cycle, not necessarily before the next line.
	ingestAnswers(t, "after delete", send, http.StatusForbidden, `"project_deleted"`)
	if resp := f.createProject(owner, "acme", "Shop again", "shop"); resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "slug_taken" {
		t.Fatalf("re-create deleted slug: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Get(ProjectSlugAvailablePath+"?slug=shop", as(owner)); !strings.Contains(resp.Body.String(), `"available":false`) {
		t.Fatalf("slug-available after delete: %s", resp.Body)
	}

	// Only organization owners and admins list and restore.
	for _, name := range []string{"admin", "outsider"} {
		if resp := f.api.Get(deleted, as(f.users[name])); resp.Code != http.StatusForbidden {
			t.Errorf("list deleted as %s: %d %s", name, resp.Code, resp.Body)
		}
		if resp := f.api.Post(restore, as(f.users[name])); resp.Code != http.StatusForbidden {
			t.Errorf("restore as %s: %d %s", name, resp.Code, resp.Body)
		}
	}
	list := decode[[]DeletedProject](t, f.api.Get(deleted, as(orgAdmin)))
	if len(list) != 1 || list[0].ID != f.project.String() || !list[0].PurgeAfter.Equal(got.PurgeAfter) {
		t.Fatalf("deleted list = %+v", list)
	}
	if resp := f.api.Post(restore, as(owner), signedIn(11*time.Minute)); resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "reauth_required" {
		t.Fatalf("restore with a stale sign-in: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM projects WHERE id = $1 AND deleted_at IS NOT NULL`, f.project); n != 1 {
		t.Fatal("a refused restore restored the project")
	}

	// Restore: everything as before.
	resp = f.api.Post(restore, as(orgAdmin))
	if resp.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", resp.Code, resp.Body)
	}
	if p := decode[Project](t, resp); p.ID != f.project.String() || p.Slug != "shop" || p.Role != "admin" || len(p.Environments) != 2 {
		t.Fatalf("restored = %+v", p)
	}
	if after := f.accessView(t); len(after) != len(before) {
		t.Fatalf("access after restore = %v, want %v", after, before)
	} else {
		for name, role := range before {
			if after[name] != role {
				t.Errorf("%s after restore: %s, want %s", name, after[name], role)
			}
		}
	}
	ingestAnswers(t, "after restore", send, http.StatusOK, `"accepted":1`)
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'project.restored' AND project_id = $1 AND actor_user_id = $2`, f.project, orgAdmin); n != 1 {
		t.Fatalf("project.restored audited %d times", n)
	}
	if list := decode[[]DeletedProject](t, f.api.Get(deleted, as(owner))); len(list) != 0 {
		t.Fatalf("deleted list after restore = %+v", list)
	}
	if resp := f.api.Post(restore, as(owner)); resp.Code != http.StatusNotFound {
		t.Fatalf("restore an active project: %d %s", resp.Code, resp.Body)
	}
}

// Once purge_after has passed the project can no longer be restored or
// listed, and its slug stays reserved until the purge job runs.
func TestRestoreRefusedOncePurgeIsDue(t *testing.T) {
	f := setupDeletion(t)
	owner := f.users["owner"]
	if resp := f.api.Delete(ProjectsPath+"/shop", as(owner), map[string]any{"confirm": "shop"}); resp.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	// A project of another organization cannot be restored through it.
	f.mustCreate(t, owner, "Other", "other")
	if resp := f.api.Post(OrgsPath+"/other/projects/"+f.project.String()+"/restore", as(owner)); resp.Code != http.StatusNotFound {
		t.Fatalf("restore through another org: %d %s", resp.Code, resp.Body)
	}
	if list := decode[[]DeletedProject](t, f.api.Get(OrgsPath+"/other/projects/deleted", as(owner))); len(list) != 0 {
		t.Fatalf("another org lists acme's deleted project: %+v", list)
	}

	if _, err := f.pool.Exec(f.ctx, `UPDATE projects SET purge_after = now() - interval '1 second' WHERE id = $1`, f.project); err != nil {
		t.Fatal(err)
	}
	if list := decode[[]DeletedProject](t, f.api.Get(OrgsPath+"/acme/projects/deleted", as(owner))); len(list) != 0 {
		t.Fatalf("deleted list past purge_after = %+v", list)
	}
	if resp := f.api.Post(OrgsPath+"/acme/projects/"+f.project.String()+"/restore", as(owner)); resp.Code != http.StatusNotFound {
		t.Fatalf("restore past purge_after: %d %s", resp.Code, resp.Body)
	}
	if resp := f.createProject(owner, "acme", "Shop again", "shop"); resp.Code != http.StatusConflict {
		t.Fatalf("re-create a slug awaiting purge: %d %s", resp.Code, resp.Body)
	}
}
