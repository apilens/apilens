// Package query is the read side of APILens: the dashboard API.
//
// This is the first slice of the M3 query role: fixed, parameterised queries
// over the rollups and raw tables. Callers are either signed-in users, who
// name the project with `?project=<slug>` and must hold project.view on it
// (checked against SpiceDB, failing closed), or scripts holding a project
// read key, whose project is the key's. Either way every query filters on
// the resolved project first. M3 replaces the fixed queries with the typed
// query compiler (ADR 0004).
package query

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// Scope required on keys that read data.
const Scope = "read"

// Verifier resolves API keys.
type Verifier interface {
	Verify(ctx context.Context, raw string) (apikeys.Principal, error)
}

// Catalog is the control-plane subset the query API needs.
type Catalog interface {
	GetProjectWithOrg(ctx context.Context, id uuid.UUID) (db.GetProjectWithOrgRow, error)
	ListProjectApps(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectAppsRow, error)
}

// Service holds the dependencies of the query handlers.
type Service struct {
	ch      driver.Conn
	catalog Catalog
	quota   IngestQuota // ingest limits reported by ingest-status
	now     func() time.Time

	ingestStats IngestStatsReader // nil: app ingest-stats answers 503
	exports     *exportDeps       // nil: the export operations answer 503
	alerts      *alertDeps        // nil: the alert operations answer 503
}

// NewService builds a Service.
func NewService(ch driver.Conn, catalog Catalog) *Service {
	return &Service{ch: ch, catalog: catalog, now: time.Now}
}

// ProjectAuthorizer decides whether a principal may use the project a slug
// names; *authz.Guard satisfies it. It returns authz.ErrNoResource for a
// project that does not exist or that the principal cannot view, and an
// error wrapping authz.ErrUnavailable when it cannot answer.
type ProjectAuthorizer interface {
	AuthorizeProject(ctx context.Context, p authn.Principal, slug string, permission authz.Permission) (authz.Target, error)
}

// ParamProject is the query parameter naming the project.
const ParamProject = "project"

// scope is the project every query of a request is filtered on.
type scope struct {
	ProjectID uuid.UUID
}

type principalKey struct{}

func principalFrom(ctx context.Context) (scope, error) {
	p, ok := ctx.Value(principalKey{}).(scope)
	if !ok {
		return scope{}, huma.Error401Unauthorized("a session or read key is required")
	}
	return p, nil
}

// SchemeReadKey is the OpenAPI security scheme of project read keys.
const SchemeReadKey = "readKey"

// security marks an operation as accepting a user session or a read key.
var security = []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}}

// AddSecurityScheme documents read-key auth in the OpenAPI spec.
func AddSecurityScheme(api huma.API) {
	oa := api.OpenAPI()
	if oa.Components == nil {
		oa.Components = &huma.Components{}
	}
	if oa.Components.SecuritySchemes == nil {
		oa.Components.SecuritySchemes = map[string]*huma.SecurityScheme{}
	}
	oa.Components.SecuritySchemes[SchemeReadKey] = &huma.SecurityScheme{
		Type:        "http",
		Scheme:      "bearer",
		Description: "Project read key (scope `read`), printed by `apilens seed` as `read_key`.",
	}
}

// AuthMiddleware authenticates and scopes operations that declare the
// readKey scheme. Install it before registering the operations it should
// guard, and after authn.Middleware.
//
// A request already authenticated by a session must name the project with
// ?project=<slug> (422 without it) and is let through only when projects
// grants project.view on it: 404 when the project does not exist or is not
// visible to the caller, 503 when authorization cannot be answered (fail
// closed). Otherwise the bearer must be a read key, whose project is used;
// a ?project= sent with a read key must name that same project. The key is
// stored as an authn.Principal too.
//
// Operations naming the project in their path ({project}) authorize it
// themselves with authz.Guard: a session is passed on untouched, and a read
// key is scoped to its own project for the guard to compare.
func AuthMiddleware(api huma.API, v Verifier, projects ProjectAuthorizer) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if !authn.Declares(ctx.Operation(), SchemeReadKey) {
			next(ctx)
			return
		}
		slug := ctx.Query(ParamProject)
		if p, ok := authn.FromContext(ctx.Context()); ok {
			if ctx.Param(authz.ParamProject) != "" {
				// The project is in the path: the operation's own
				// authz.Guard middleware authorizes the session.
				next(ctx)
				return
			}
			if slug == "" {
				_ = huma.WriteErr(api, ctx, http.StatusUnprocessableEntity, "the project query parameter is required with a session (?project=<slug>)")
				return
			}
			authorizeProject(api, ctx, projects, p, slug, next)
			return
		}
		raw := ""
		if h := ctx.Header("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
			raw = strings.TrimSpace(h[7:])
		}
		p, err := v.Verify(ctx.Context(), raw)
		switch {
		case raw == "" || errors.Is(err, apikeys.ErrInvalidKey):
			ctx.SetHeader("WWW-Authenticate", `Bearer realm="apilens"`)
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "a valid read key or session is required (Authorization: Bearer <read_key|access_token>)")
		case err != nil:
			ctx.SetHeader("Retry-After", "1")
			_ = huma.WriteErr(api, ctx, http.StatusServiceUnavailable, "authentication backend unavailable, retry later")
		case !p.HasScope(Scope):
			_ = huma.WriteErr(api, ctx, http.StatusForbidden, "this key cannot read data; use the read_key printed by `apilens seed`")
		case slug != "":
			authorizeProject(api, ctx, projects, p.Authn(), slug, next)
		default:
			c := context.WithValue(ctx.Context(), principalKey{}, scope{ProjectID: p.ProjectID})
			next(huma.WithContext(ctx, authn.WithPrincipal(c, p.Authn())))
		}
	}
}

// authorizeProject lets the request through scoped to the project slug names
// when p may view it.
func authorizeProject(api huma.API, ctx huma.Context, projects ProjectAuthorizer, p authn.Principal, slug string, next func(huma.Context)) {
	var (
		t   authz.Target
		err = authz.ErrUnavailable
	)
	if projects != nil {
		t, err = projects.AuthorizeProject(ctx.Context(), p, slug, authz.ProjectView)
	}
	switch {
	case err == nil:
		c := context.WithValue(ctx.Context(), principalKey{}, scope{ProjectID: t.ProjectID})
		next(huma.WithContext(ctx, authn.WithPrincipal(c, p)))
	case errors.Is(err, authz.ErrNoResource), errors.Is(err, authz.ErrForbidden):
		_ = huma.WriteErr(api, ctx, http.StatusNotFound, "project not found")
	case errors.Is(err, authz.ErrUnavailable):
		ctx.SetHeader("Retry-After", "1")
		_ = huma.WriteErr(api, ctx, http.StatusServiceUnavailable, "authorization backend unavailable, retry later")
	default:
		_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "authorization failed")
	}
}

// window is a resolved time range.
type window struct {
	name   string
	from   time.Time // inclusive, bucket-aligned
	to     time.Time // exclusive, bucket-aligned
	bucket time.Duration
	table  string // rollup table to read
}

var ranges = map[string]struct {
	span   time.Duration
	bucket time.Duration
	table  string
}{
	"1h":  {time.Hour, time.Minute, "api_requests_1m"},
	"6h":  {6 * time.Hour, 5 * time.Minute, "api_requests_1m"},
	"24h": {24 * time.Hour, 15 * time.Minute, "api_requests_1m"},
	"7d":  {7 * 24 * time.Hour, time.Hour, "api_requests_1h"},
}

func resolveWindow(name string, now time.Time) (window, error) {
	if name == "" {
		name = "24h"
	}
	r, ok := ranges[name]
	if !ok {
		return window{}, huma.Error422UnprocessableEntity("range must be one of 1h, 6h, 24h, 7d")
	}
	to := now.UTC().Truncate(r.bucket).Add(r.bucket)
	return window{name: name, from: to.Add(-r.span), to: to, bucket: r.bucket, table: r.table}, nil
}

// queryCtx bounds every dashboard query.
func queryCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"max_execution_time":   15,
		"max_result_rows":      100_000,
		"result_overflow_mode": "break",
	}))
	return context.WithTimeout(ctx, 20*time.Second)
}

// tenantFilter builds the mandatory project predicate plus optional
// environment. It is the only way handlers start a WHERE clause.
func tenantFilter(project uuid.UUID, env string) (string, []any) {
	if env == "" {
		return "project_id = ?", []any{project}
	}
	return "project_id = ? AND environment = ?", []any{project, env}
}

func finite(f float32) float64 {
	v := float64(f)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

func quantile(q []float32, i int) float64 {
	if i >= len(q) {
		return 0
	}
	return finite(q[i])
}

func internalError(op string, err error) error {
	return huma.Error500InternalServerError(fmt.Sprintf("%s failed", op), err)
}
