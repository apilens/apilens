// Package query is the read side of APILens: the dashboard API.
//
// This is the first slice of the M3 query role: fixed, parameterised queries
// over the rollups and raw tables. Every query takes the project from the
// caller's read key and filters on it first; there is no way to name a
// project in a request. M3 replaces the fixed queries with the typed query
// compiler (ADR 0004) and M2 replaces read keys with user sessions.
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

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/store/db"
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
	now     func() time.Time
}

// NewService builds a Service.
func NewService(ch driver.Conn, catalog Catalog) *Service {
	return &Service{ch: ch, catalog: catalog, now: time.Now}
}

type principalKey struct{}

func principalFrom(ctx context.Context) (apikeys.Principal, error) {
	p, ok := ctx.Value(principalKey{}).(apikeys.Principal)
	if !ok {
		return apikeys.Principal{}, huma.Error401Unauthorized("a read key is required")
	}
	return p, nil
}

// security marks an operation as requiring a read key.
var security = []map[string][]string{{"readKey": {}}}

// AddSecurityScheme documents read-key auth in the OpenAPI spec.
func AddSecurityScheme(api huma.API) {
	oa := api.OpenAPI()
	if oa.Components == nil {
		oa.Components = &huma.Components{}
	}
	if oa.Components.SecuritySchemes == nil {
		oa.Components.SecuritySchemes = map[string]*huma.SecurityScheme{}
	}
	oa.Components.SecuritySchemes["readKey"] = &huma.SecurityScheme{
		Type:        "http",
		Scheme:      "bearer",
		Description: "Project read key (scope `read`), printed by `apilens seed` as `read_key`.",
	}
}

// AuthMiddleware authenticates operations that declare the readKey scheme.
// Install it before registering the operations it should guard.
func AuthMiddleware(api huma.API, v Verifier) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if op := ctx.Operation(); op == nil || len(op.Security) == 0 {
			next(ctx)
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
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "a valid read key is required (Authorization: Bearer <read_key>)")
		case err != nil:
			ctx.SetHeader("Retry-After", "1")
			_ = huma.WriteErr(api, ctx, http.StatusServiceUnavailable, "authentication backend unavailable, retry later")
		case !p.HasScope(Scope):
			_ = huma.WriteErr(api, ctx, http.StatusForbidden, "this key cannot read data; use the read_key printed by `apilens seed`")
		default:
			next(huma.WithValue(ctx, principalKey{}, p))
		}
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
