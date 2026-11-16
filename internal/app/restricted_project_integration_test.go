//go:build integration

package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/access"
	controlplaneapi "github.com/apilens/apilens/internal/controlplane/api"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// restrictedUserHeader names the signed-in user of a test request.
const restrictedUserHeader = "X-Test-User"

// notProjectScoped are the path prefixes of operations that never read or
// change one project's data, so a restricted project has nothing to hide
// there. Every other operation of the spec must be project scoped (see
// projectScoped) and is called by TestRestrictedProjectHiddenFromEveryOperation.
var notProjectScoped = []struct{ prefix, why string }{
	{"/api/v1/auth/", "sign-in, session and account recovery flows of the caller"},
	{"/api/v1/users/me", "the caller's own account; the user context's project list is asserted below"},
	{"/api/v1/orgs", "organization resources, guarded by organization permissions; the project list is asserted below"},
	{"/api/v1/meta", "install metadata"},
	{"/api/v1/projects/slug-available", "global slug availability, no project data"},
	{"/v1/", "ingest, authorized by the project's ingest key"},
}

// exemptOperations are project-scoped operations that are authorized
// otherwise than by the caller's session.
var exemptOperations = map[string]string{
	"download-request-export": "authorized by the signed link that get-request-export (asserted here) hands out, not by a session",
}

// projectScoped reports whether an operation reads or changes the data of
// the project its path, its app or export id, or its ?project= names.
func projectScoped(path string, security []map[string][]string) bool {
	switch {
	case strings.Contains(path, "{project}"),
		strings.HasPrefix(path, "/api/v1/projects/{slug}"),
		strings.HasPrefix(path, "/api/v1/apps/"),
		strings.HasPrefix(path, "/api/v1/exports/"):
		return true
	}
	for _, s := range security {
		if _, ok := s[query.SchemeReadKey]; ok {
			return true // ?project=<slug> with a session
		}
	}
	return false
}

// specOperation is one operation of the OpenAPI document.
type specOperation struct {
	ID, Method, Path string
	Security         []map[string][]string
}

// specOperations reads every operation from the Huma registry, through the
// same document `apilens openapi` prints.
func specOperations(t *testing.T) []specOperation {
	t.Helper()
	var buf bytes.Buffer
	if err := runOpenAPI(&buf); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	var ops []specOperation
	for path, item := range doc.Paths {
		for method, raw := range item {
			switch method {
			case "get", "post", "put", "patch", "delete":
			default:
				continue
			}
			var o struct {
				OperationID string                `json:"operationId"`
				Security    []map[string][]string `json:"security"`
			}
			if err := json.Unmarshal(raw, &o); err != nil {
				t.Fatal(err)
			}
			ops = append(ops, specOperation{ID: o.OperationID, Method: strings.ToUpper(method), Path: path, Security: o.Security})
		}
	}
	slices.SortFunc(ops, func(a, b specOperation) int { return strings.Compare(a.ID, b.ID) })
	return ops
}

// restrictedFixture is org acme with project shop: owner owns acme,
// outsider is a plain org member. Every kind of object an operation can
// name by id exists in shop.
type restrictedFixture struct {
	ctx             context.Context
	pool            *pgxpool.Pool
	api             humatest.TestAPI
	owner, outsider uuid.UUID
	org, project    uuid.UUID
	ids             map[string]string // path segment before {id} → id of a shop object
	served          map[string]bool   // "METHOD path" served by api
	relay           *outbox.Relay
}

func setupRestricted(t *testing.T) *restrictedFixture {
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
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}
	checker := authz.New(sdb, authz.NewValkeyTokens(client), authz.Options{}, logger, nil)
	relay := outbox.NewRelay(pool, sdb, checker, outbox.RelayOptions{}, logger, nil)
	guard := authz.NewGuard(checker, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)

	_, api := humatest.New(t)
	f := &restrictedFixture{ctx: ctx, pool: pool, api: api, relay: relay, ids: map[string]string{}, served: map[string]bool{}}

	// A handler reached without a guard must not take the test down: a
	// panic (the ClickHouse connection is nil) answers 500.
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		defer func() {
			if r := recover(); r != nil {
				ctx.SetStatus(http.StatusInternalServerError)
				_, _ = fmt.Fprintf(ctx.BodyWriter(), "panic: %v", r)
			}
		}()
		next(ctx)
	})
	// Sessions as the app's authn middleware leaves them, signed in just
	// now; the relay is drained first so each request sees every change.
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if _, err := relay.Drain(ctx.Context()); err != nil {
			t.Errorf("relay: %v", err)
		}
		id, err := uuid.Parse(ctx.Header(restrictedUserHeader))
		if err != nil {
			next(ctx)
			return
		}
		c := authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: id, AuthTime: time.Now()})
		c = audit.WithRequest(c, audit.Request{IP: netip.MustParseAddr("203.0.113.7"), UserAgent: "itest"})
		next(huma.WithContext(ctx, c))
	})

	// The query role, as initQuery wires it (ClickHouse left out: a guarded
	// request never reaches a query).
	queries := db.New(pool)
	verifier := apikeys.NewVerifier(queries, apikeys.Options{}, logger, nil)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	store, err := query.NewLocalExportStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	kek := make([]byte, 32)
	_, _ = rand.Read(kek)
	sealer, err := idkeys.NewSealer(kek)
	if err != nil {
		t.Fatal(err)
	}
	svc := query.NewService(nil, queries)
	svc.WithExports(pool, nil, store)
	svc.WithAlerts(pool, sealer, nil)
	svc.WithAudit(pool, audit.New(pool))
	query.Register(api, svc, guard)

	// The api role, as initAPI wires it.
	orgService := orgs.New(pool, audit.New(pool))
	controlplaneapi.Register(api, controlplaneapi.Deps{
		Orgs:     orgService,
		Members:  orgService,
		Apps:     appsvc.NewService(pool, audit.New(pool)),
		Access:   access.New(pool).WithAudit(audit.New(pool)),
		Audit:    auditlog.New(pool, checker),
		Projects: projects.New(pool).WithAudit(audit.New(pool)),
		APIKeys:  apikeys.NewService(pool, audit.New(pool), func(context.Context, string) error { return nil }, logger),
		Privacy:  privacy.NewService(pool).WithAudit(audit.New(pool)),
		Capture:  capture.NewService(pool, audit.New(pool)),
		Context:  usercontext.New(pool, checker),
		Guard:    guard,
		Roles:    checker,
		Limiter:  limiter,
		Logger:   logger,
	})
	for path, item := range api.OpenAPI().Paths {
		for method, op := range map[string]*huma.Operation{
			http.MethodGet: item.Get, http.MethodPost: item.Post, http.MethodPut: item.Put,
			http.MethodPatch: item.Patch, http.MethodDelete: item.Delete,
		} {
			if op != nil {
				f.served[method+" "+path] = true
			}
		}
	}

	f.owner = f.user(t, "restricted-owner@example.com")
	f.outsider = f.user(t, "restricted-outsider@example.com")
	f.org = uuid.MustParse(f.mustCreate(t, controlplaneapi.OrgsPath, map[string]any{"name": "Acme", "slug": "acme"}))
	f.join(t, f.outsider, "member")
	f.project = uuid.MustParse(f.mustCreate(t, controlplaneapi.OrgsPath+"/acme/projects",
		map[string]any{"name": "Shop", "slug": "shop", "environments": []string{"production"}}))
	f.seedObjects(t)
	return f
}

func (f *restrictedFixture) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	now := time.Now()
	u, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: email, EmailVerifiedAt: &now, Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func as(user uuid.UUID) string { return restrictedUserHeader + ": " + user.String() }

// mustCreate posts body to path as the owner and returns the new id.
func (f *restrictedFixture) mustCreate(t *testing.T, path string, body any) string {
	t.Helper()
	resp := f.api.Post(path, as(f.owner), body)
	if resp.Code != http.StatusCreated {
		t.Fatalf("POST %s: %d %s", path, resp.Code, resp.Body)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil || out.ID == "" {
		t.Fatalf("POST %s: id in %s: %v", path, resp.Body, err)
	}
	return out.ID
}

// tx runs fn in a transaction.
func (f *restrictedFixture) tx(t *testing.T, fn func(tx pgx.Tx, emit func(outbox.Topic, uuid.UUID, outbox.Payload))) {
	t.Helper()
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	fn(tx, func(topic outbox.Topic, aggregate uuid.UUID, p outbox.Payload) {
		if err := outbox.Emit(f.ctx, tx, topic, aggregate, p); err != nil {
			t.Fatal(err)
		}
	})
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
}

// join makes user an acme member with role.
func (f *restrictedFixture) join(t *testing.T, user uuid.UUID, role string) {
	t.Helper()
	f.tx(t, func(tx pgx.Tx, emit func(outbox.Topic, uuid.UUID, outbox.Payload)) {
		if _, err := tx.Exec(f.ctx, `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)`, f.org, user, role); err != nil {
			t.Fatal(err)
		}
		emit(outbox.MembershipUpserted, f.org, outbox.MembershipUpsertedPayload{OrgID: f.org, UserID: user, Role: role})
	})
}

// setDefaultAccess sets shop's default access for org members.
func (f *restrictedFixture) setDefaultAccess(t *testing.T, value string) {
	t.Helper()
	f.tx(t, func(tx pgx.Tx, emit func(outbox.Topic, uuid.UUID, outbox.Payload)) {
		if _, err := db.New(tx).SetProjectDefaultAccess(f.ctx, db.SetProjectDefaultAccessParams{ID: f.project, DefaultAccess: value}); err != nil {
			t.Fatal(err)
		}
		emit(outbox.ProjectAccessChanged, f.project, outbox.ProjectAccessChangedPayload{ProjectID: f.project, OrgID: f.org, DefaultAccess: value})
	})
}

// seedObjects creates in shop one object of every kind an operation names
// by id, and records the ids by the path segment before {id}.
func (f *restrictedFixture) seedObjects(t *testing.T) {
	t.Helper()
	seeded, err := bootstrap.Seed(f.ctx, f.pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	if seeded.ProjectID != f.project {
		t.Fatalf("seed went to project %s, want %s", seeded.ProjectID, f.project)
	}
	f.ids["apps"] = seeded.AppID.String()
	q := db.New(f.pool)
	keys, err := q.ListProjectAPIKeys(f.ctx, f.project)
	if err != nil || len(keys) == 0 {
		t.Fatalf("api keys of shop: %v %v", keys, err)
	}
	f.ids["api-keys"] = keys[0].ID.String()

	owner, outsider := f.owner, f.outsider
	view, err := q.CreateSavedView(f.ctx, db.CreateSavedViewParams{
		ID: uuid.New(), ProjectID: f.project, Name: "Slow", Surface: "endpoints", Filter: []byte(`{}`), Shared: true, CreatedBy: &owner,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.ids["views"] = view.ID.String()
	channel, err := q.CreateNotificationChannel(f.ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: f.project, Type: "webhook", Name: "Ops", ConfigEnc: []byte("sealed"), CreatedBy: &owner,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.ids["channels"] = channel.ID.String()
	every := int32(60)
	rule, err := q.CreateAlertRule(f.ctx, db.CreateAlertRuleParams{
		ID: uuid.New(), ProjectID: f.project, AppID: seeded.AppID, Environment: "production", Name: "Errors",
		Metric: "errors", Condition: "gt", Threshold: 1, WindowS: 300, EveryS: &every, Filters: []byte(`{}`), ChannelIds: []uuid.UUID{},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.ids["rules"] = rule.ID.String()
	check, err := q.CreateHealthCheck(f.ctx, db.CreateHealthCheckParams{
		ID: uuid.New(), ProjectID: f.project, AppID: seeded.AppID, Environment: "production",
		Url: "https://shop.example.com/health", ExpectedStatus: 200, Enabled: true, CreatedBy: &owner,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.ids["health-checks"] = check.ID.String()
	// The outsider's own export, started while they could still view shop.
	now := time.Now().UTC()
	export, err := q.CreateRequestExport(f.ctx, db.CreateRequestExportParams{
		ID: uuid.Must(uuid.NewV7()), ProjectID: f.project, CreatedBy: &outsider, Filter: []byte(`{"range":"24h"}`),
		RangeFrom: now.Add(-24 * time.Hour), RangeTo: now, RowLimit: query.MaxExportRows, SigningKey: make([]byte, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.ids["exports"] = export.ID.String()
}

var pathParam = regexp.MustCompile(`\{([a-z_]+)\}`)

// resolve fills the path parameters of an operation with shop and the ids
// of shop's objects. ok is false when the path holds a parameter the test
// does not know how to fill.
func (f *restrictedFixture) resolve(path string) (string, bool, string) {
	var unknown string
	out := pathParam.ReplaceAllStringFunc(path, func(m string) string {
		name := m[1 : len(m)-1]
		switch name {
		case "project", "slug":
			return "shop"
		case "user_id":
			return f.owner.String()
		case "name":
			return "production"
		case "method":
			return "GET"
		case "path":
			return "%2Fusers"
		case "consumer_id":
			return "consumer-1"
		case "trace_id":
			return "4bf92f3577b34da6a3ce929d0e0e4736"
		case "code":
			return "500"
		case "id":
			before := path[:strings.Index(path, m)]
			parts := strings.Split(strings.TrimSuffix(before, "/"), "/")
			segment := parts[len(parts)-1]
			if id, ok := f.ids[segment]; ok {
				return id
			}
			if segment == "deploys" || segment == "requests" {
				return uuid.NewString() // rows of ClickHouse; the guard answers first
			}
		}
		unknown = name + " in " + path
		return m
	})
	return out, unknown == "", unknown
}

// call runs the operation as user, naming shop with ?project= too (the
// query role's session operations need it; the others ignore it).
func (f *restrictedFixture) call(op specOperation, path string, user uuid.UUID) *httptest.ResponseRecorder {
	path += "?project=shop"
	if op.Method == http.MethodGet || op.Method == http.MethodDelete {
		return f.api.Do(op.Method, path, as(user))
	}
	body, ok := restrictedBodies[op.ID]
	if !ok {
		body = map[string]any{}
	}
	return f.api.Do(op.Method, path, as(user), body)
}

// restrictedBodies are valid request bodies for operations that authorize
// in the handler, after Huma validated the input (a 422 there says nothing
// about the project); every other write gets an empty object.
var restrictedBodies = map[string]any{
	"add-project-environment":      map[string]any{"name": "qa"},
	"create-api-key":               map[string]any{"name": "CI", "scopes": []string{"ingest"}},
	"merge-app":                    map[string]any{"into": uuid.NewString()},
	"rename-app":                   map[string]any{"name": "Storefront"},
	"rotate-api-key":               map[string]any{"overlap": "none"},
	"set-project-default-access":   map[string]any{"default_access": "org_role"},
	"set-project-member-role":      map[string]any{"role": "admin"},
	"update-api-key-access":        map[string]any{"can_create_apps": true, "app_ids": nil},
	"put-endpoint-settings":        map[string]any{"excluded": true},
	"reorder-project-environments": map[string]any{"names": []string{"production"}},
	"put-capture-policy": map[string]any{
		"enabled": true, "sample_rate": 1, "capture_headers": true, "capture_request_body": true, "capture_response_body": true,
	},
}

// TestRestrictedProjectHiddenFromEveryOperation calls every project-scoped
// operation of the API as an org member without access to a project whose
// default access is none, and expects 404 not_found from each: no
// operation, whether it names the project by slug, by ?project=, or through
// an app, export, saved view, alert rule, channel, health check or key id,
// may read or change a restricted project. An operation that is neither
// project scoped nor listed in notProjectScoped fails the test, so a new
// operation is classified (and guarded) before it ships.
func TestRestrictedProjectHiddenFromEveryOperation(t *testing.T) {
	f := setupRestricted(t)
	ops := specOperations(t)

	var scoped []specOperation
	for _, op := range ops {
		if projectScoped(op.Path, op.Security) {
			if _, ok := exemptOperations[op.ID]; !ok {
				scoped = append(scoped, op)
			}
			continue
		}
		if !slices.ContainsFunc(notProjectScoped, func(n struct{ prefix, why string }) bool { return strings.HasPrefix(op.Path, n.prefix) }) {
			t.Errorf("%s (%s %s) is neither project scoped nor listed in notProjectScoped: guard it and classify it here", op.ID, op.Method, op.Path)
		}
	}
	if len(scoped) < 50 {
		t.Fatalf("only %d project-scoped operations found; the spec walk is broken", len(scoped))
	}

	// While shop is open to org members (default access org_role), the
	// outsider reaches every object: the 404s below come from the
	// restriction, not from ids that name nothing.
	for _, op := range scoped {
		if !f.served[op.Method+" "+op.Path] {
			t.Errorf("%s (%s %s) is in the spec but not registered by query.Register or controlplaneapi.Register", op.ID, op.Method, op.Path)
			continue
		}
		path, ok, unknown := f.resolve(op.Path)
		if !ok {
			t.Errorf("%s: no value for path parameter %s; teach resolve about it", op.ID, unknown)
			continue
		}
		if op.Method != http.MethodGet || !strings.Contains(op.Path, "{id}") || strings.Contains(path, "/deploys/") || strings.Contains(path, "/requests/") {
			continue
		}
		if resp := f.call(op, path, f.outsider); resp.Code == http.StatusNotFound {
			t.Errorf("%s on open shop as org member: 404 %s, want the object found", op.ID, resp.Body)
		}
	}
	if t.Failed() {
		t.FailNow()
	}

	f.setDefaultAccess(t, "none")
	for _, op := range scoped {
		path, _, _ := f.resolve(op.Path)
		resp := f.call(op, path, f.outsider)
		if resp.Code != http.StatusNotFound {
			t.Errorf("%s (%s %s) on restricted shop as org member without access: %d %s, want 404", op.ID, op.Method, path, resp.Code, truncate(resp.Body.String()))
		}
	}

	// Lists across projects leave shop out.
	resp := f.api.Get(controlplaneapi.OrgsPath+"/acme/projects", as(f.outsider))
	if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), `"shop"`) {
		t.Errorf("list-projects as outsider: %d %s, want 200 without shop", resp.Code, resp.Body)
	}
	resp = f.api.Get(controlplaneapi.UserContextPath, as(f.outsider))
	if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), `"shop"`) {
		t.Errorf("get-user-context as outsider: %d %s, want 200 without shop", resp.Code, resp.Body)
	}
	// The owner still sees it (the lists are not simply empty).
	if resp := f.api.Get(controlplaneapi.OrgsPath+"/acme/projects", as(f.owner)); !strings.Contains(resp.Body.String(), `"shop"`) {
		t.Errorf("list-projects as owner: %d %s, want shop", resp.Code, resp.Body)
	}
}

func truncate(s string) string {
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}
