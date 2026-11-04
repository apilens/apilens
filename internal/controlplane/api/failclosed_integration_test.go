//go:build integration

package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/testutil"
)

// liveCacheTTL is authz.cache_ttl for the live fixture: short, so the test
// can wait out allowed results cached before an outage.
const liveCacheTTL = time.Second

// projectUpdateProbePath is an operation guarded by project.update
// (authz.ProjectEdit) on the project {project}; its handler does nothing.
const projectUpdateProbePath = server.APIPrefix + "/authz-probe/projects/{project}"

// liveFixture is orgsFixture wired the way apilens runs: SpiceDB on a
// Postgres datastore that the test can stop and start, the outbox relay
// woken by NOTIFY and also run every outbox.RelayInterval (the periodic
// job), and nothing forcing the relay before a request.
type liveFixture struct {
	*orgsFixture
	spicedb *testutil.SpiceDBServer
}

func setupLive(t *testing.T) *liveFixture {
	t.Helper()
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	client, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(client, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := testutil.RestartableSpiceDB(t)
	sdb, err := spicedb.Connect(srv.Config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}
	checker := authz.New(sdb, authz.NewValkeyTokens(client), authz.Options{CacheTTL: liveCacheTTL, Timeout: time.Second}, logger, nil)
	relay := outbox.NewRelay(pool, sdb, checker, outbox.RelayOptions{}, logger, nil)
	guard := authz.NewGuard(checker, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)

	runCtx, cancel := context.WithCancel(ctx)
	listening, ticking := make(chan error, 1), make(chan struct{})
	go func() { listening <- relay.Listen(runCtx) }()
	go func() {
		defer close(ticking)
		tick := time.NewTicker(outbox.RelayInterval)
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				_, _ = relay.Drain(runCtx) // failures stay pending for the next run
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-listening; err != nil {
			t.Error(err)
		}
		<-ticking
	})

	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		id, err := uuid.Parse(ctx.Header(testUserHeader))
		if err != nil {
			next(ctx)
			return
		}
		c := authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: id})
		c = audit.WithRequest(c, audit.Request{IP: netip.MustParseAddr("203.0.113.7"), UserAgent: "itest"})
		next(huma.WithContext(ctx, c))
	})
	svc := orgs.New(pool, audit.New(pool))
	NewOrgs(svc, guard, limiter, ratelimit.Rate{}, logger).Register(api)
	NewMembers(svc, guard, logger).Register(api)
	NewProjects(projects.New(pool), nil, ratelimit.Rate{}, logger).Register(api)
	huma.Register(api, huma.Operation{
		OperationID: "probe-project-update",
		Method:      http.MethodPatch,
		Path:        projectUpdateProbePath,
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectEdit)},
	}, func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })

	return &liveFixture{orgsFixture: &orgsFixture{api: api, pool: pool, ctx: ctx}, spicedb: srv}
}

// settle waits until the relay has applied every outbox row.
func (f *liveFixture) settle(t *testing.T) {
	t.Helper()
	within(t, 10*time.Second, "outbox drained", func() bool {
		return f.count(t, `SELECT count(*) FROM outbox WHERE processed_at IS NULL`) == 0
	})
}

func (f *liveFixture) probeProjectUpdate(slug string, caller uuid.UUID) *httptest.ResponseRecorder {
	return f.api.Patch(strings.Replace(projectUpdateProbePath, "{project}", slug, 1), as(caller), map[string]any{})
}

// within polls cond until it holds, failing the test after d. It returns
// how long it took.
func within(t *testing.T, d time.Duration, what string, cond func() bool) time.Duration {
	t.Helper()
	start := time.Now()
	for !cond() {
		if time.Since(start) > d {
			t.Fatalf("%s: not true within %v", what, d)
		}
		time.Sleep(20 * time.Millisecond)
	}
	took := time.Since(start)
	t.Logf("%s after %v", what, took.Round(time.Millisecond))
	return took
}

func success(code int) bool { return code >= 200 && code < 300 }

// expectDown requires the answer of a guarded operation while SpiceDB is
// down: never a success, and specifically 503 authz_unavailable with
// Retry-After, since no check can be answered (a 403 would also be closed,
// but would mean a decision was made without SpiceDB).
func expectDown(t *testing.T, what string, resp *httptest.ResponseRecorder) {
	t.Helper()
	if success(resp.Code) {
		t.Errorf("%s while SpiceDB is down: %d %s; FAILED OPEN", what, resp.Code, resp.Body)
		return
	}
	if resp.Code != http.StatusServiceUnavailable || decode[problem](t, resp).Code != "authz_unavailable" || resp.Header().Get("Retry-After") == "" {
		t.Errorf("%s while SpiceDB is down: %d %v %s, want 503 authz_unavailable", what, resp.Code, resp.Header(), resp.Body)
	}
}

// TestAuthzFailsClosedWhileSpiceDBIsDown stops the SpiceDB container and
// calls every authz.Require-guarded operation as every role: none may
// succeed. It then starts SpiceDB again and requires apilens (the same
// clients, no restart) to answer correctly once more, including a
// membership granted while SpiceDB was down.
func TestAuthzFailsClosedWhileSpiceDBIsDown(t *testing.T) {
	f := setupLive(t)
	users := map[string]uuid.UUID{}
	for _, role := range []string{"owner", "admin", "member", "viewer", "stranger", "target", "late"} {
		users[role] = f.user(t, "fc-"+role+"@example.com")
	}
	f.mustCreate(t, users["stranger"], "Elsewhere", "elsewhere")
	f.mustCreate(t, users["owner"], "Acme", "acme")
	for _, r := range []string{"admin", "member", "viewer"} {
		f.join(t, "acme", users[r], r)
	}
	f.join(t, "acme", users["target"], "member")
	f.mustCreateProject(t, users["owner"], "acme", "Web", "web")
	f.settle(t)

	// Up: the guard answers from SpiceDB.
	if resp := f.api.Get(orgPath(OrgPath, "acme"), as(users["viewer"])); resp.Code != http.StatusOK {
		t.Fatalf("viewer get-org while up: %d %s", resp.Code, resp.Body)
	}
	if resp := f.probeProjectUpdate("web", users["member"]); !success(resp.Code) {
		t.Fatalf("member project.update while up: %d %s", resp.Code, resp.Body)
	}

	const stateSQL = `SELECT count(*) FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = 'acme' AND o.deleted_at IS NULL`
	before := f.count(t, stateSQL)

	f.spicedb.Stop(t)
	// An allow cached before the outage may answer for up to cache_ttl
	// (keyed by the organization's last ZedToken); wait it out so every
	// check below has to reach SpiceDB.
	time.Sleep(liveCacheTTL + 100*time.Millisecond)

	roles := []string{"owner", "admin", "member", "viewer", "stranger"}
	for _, ep := range orgEndpoints {
		for _, role := range roles {
			resp := ep.call(f.orgsFixture, "acme", users[role], users["target"])
			expectDown(t, ep.name+" as "+role, resp)
		}
	}
	for _, role := range roles {
		expectDown(t, "project.update as "+role, f.probeProjectUpdate("web", users[role]))
	}
	if after := f.count(t, stateSQL); after != before || f.role(t, "acme", users["owner"]) != "owner" {
		t.Fatalf("a guarded write ran while SpiceDB was down: %d members, was %d", after, before)
	}

	// A membership committed while SpiceDB is down stays in the outbox.
	f.join(t, "acme", users["late"], "member")

	f.spicedb.Start(t)
	within(t, 60*time.Second, "owner can view the org again", func() bool {
		return f.api.Get(orgPath(OrgPath, "acme"), as(users["owner"])).Code == http.StatusOK
	})
	// The periodic relay applies what queued up during the outage.
	within(t, 2*outbox.RelayInterval+5*time.Second, "membership granted during the outage applies", func() bool {
		return success(f.probeProjectUpdate("web", users["late"]).Code)
	})
	for _, tc := range []struct {
		role string
		resp *httptest.ResponseRecorder
		want int
	}{
		{"viewer", f.api.Get(orgPath(OrgPath, "acme"), as(users["viewer"])), http.StatusOK},
		{"viewer", f.api.Patch(orgPath(OrgPath, "acme"), as(users["viewer"]), map[string]any{"name": "Renamed"}), http.StatusForbidden},
		{"stranger", f.api.Get(orgPath(OrgPath, "acme"), as(users["stranger"])), http.StatusNotFound},
		{"viewer", f.probeProjectUpdate("web", users["viewer"]), http.StatusForbidden},
		{"admin", f.api.Patch(orgPath(OrgPath, "acme"), as(users["admin"]), map[string]any{"name": "Renamed"}), http.StatusOK},
	} {
		if tc.resp.Code != tc.want {
			t.Errorf("as %s after recovery: %d %s, want %d", tc.role, tc.resp.Code, tc.resp.Body, tc.want)
		}
	}
	if resp := f.probeProjectUpdate("web", users["owner"]); !success(resp.Code) {
		t.Errorf("owner project.update after recovery: %d %s", resp.Code, resp.Body)
	}
}

// TestRoleChangePropagatesWithinTwoSeconds demotes an owner to viewer
// through the API and requires project.update to be denied within 2 s, with
// the relay running as in production (nothing drains it for the request).
func TestRoleChangePropagatesWithinTwoSeconds(t *testing.T) {
	f := setupLive(t)
	alice := f.user(t, "rp-alice@example.com")
	bob := f.user(t, "rp-bob@example.com")
	f.mustCreate(t, alice, "Acme", "acme")
	f.join(t, "acme", bob, "owner")
	f.mustCreateProject(t, alice, "acme", "Web", "web")
	f.settle(t)

	if resp := f.probeProjectUpdate("web", alice); !success(resp.Code) {
		t.Fatalf("owner project.update: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Patch(orgPath(OrgPath, "acme"), as(alice), map[string]any{"name": "Acme Inc"}); resp.Code != http.StatusOK {
		t.Fatalf("owner update-org: %d %s", resp.Code, resp.Body)
	}

	if resp := f.api.Patch(memberPath("acme", alice), as(bob), map[string]any{"role": "viewer"}); resp.Code != http.StatusOK {
		t.Fatalf("demote owner to viewer: %d %s", resp.Code, resp.Body)
	}
	within(t, 2*time.Second, "demoted owner denied project.update", func() bool {
		resp := f.probeProjectUpdate("web", alice)
		if success(resp.Code) {
			return false
		}
		if resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "forbidden" {
			t.Fatalf("demoted owner project.update: %d %s, want 403 forbidden", resp.Code, resp.Body)
		}
		return true
	})
	// Still a viewer: can see the org, cannot manage it.
	if resp := f.api.Get(orgPath(OrgPath, "acme"), as(alice)); resp.Code != http.StatusOK {
		t.Errorf("viewer get-org: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Patch(orgPath(OrgPath, "acme"), as(alice), map[string]any{"name": "Nope"}); resp.Code != http.StatusForbidden {
		t.Errorf("viewer update-org: %d %s", resp.Code, resp.Body)
	}
}
