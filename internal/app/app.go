// Package app is the composition root: it registers every module with the
// lifecycle manager and maps user-facing role targets onto them.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/modules"
	"github.com/apilens/apilens/internal/platform/otel"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
)

// Module names. Visible ones are role targets (-target=...).
const (
	TargetAll   = "all"
	TargetEdge  = "edge"
	TargetQuery = "query"

	modTelemetry  = "telemetry"
	modServer     = "server"
	modHTTP       = "http"
	modPostgres   = "postgres"
	modClickHouse = "clickhouse"
	modValkey     = "valkey"
	modCatalog    = "catalog"
	modSink       = "sink"
)

// PlannedTargets are roles of the target architecture that later milestones
// implement. Asking for one fails with a clear message instead of "unknown".
var PlannedTargets = map[string]string{
	"writer":    "M3 (Kafka consumers)",
	"processor": "M3 (endpoint discovery, error grouping)",
	"api":       "M2 (control-plane API)",
	"identity":  "M2 (OIDC provider, passkeys, TOTP)",
	"saml":      "M5 (isolated SAML ACS)",
	"worker":    "M4 (alerts, integrations)",
	"mcp":       "M4 (MCP server)",
}

// App wires modules for one process.
type App struct {
	cfg      *config.Config
	logger   *slog.Logger
	registry *prometheus.Registry
	mgr      *modules.Manager

	server     *server.Server
	serverWrap func(http.Handler) http.Handler
	pool       *pgxpool.Pool
	chConn     driver.Conn
	valkey     valkey.Client
	queries    *db.Queries
	verifier   *apikeys.Verifier
	apps       *catalog.AppResolver
	sink       *pipeline.DirectSink
}

// New registers all modules.
func New(cfg *config.Config, logger *slog.Logger) *App {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	a := &App{cfg: cfg, logger: logger, registry: reg, mgr: modules.New(logger, cfg.Server.ShutdownTimeout)}

	m := a.mgr
	m.Register(modTelemetry, a.initTelemetry, modules.Invisible())
	m.Register(modServer, a.initServer, modules.Invisible(), modules.DependsOn(modTelemetry))
	// The listener starts after, and stops before, every module that
	// registers routes, so in-flight requests drain before the sink does.
	m.Register(modHTTP, a.initHTTP, modules.Invisible(), modules.DependsOn(modServer), modules.After(TargetEdge, TargetQuery))
	m.Always(modHTTP)

	m.Register(modPostgres, a.initPostgres, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modClickHouse, a.initClickHouse, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modValkey, a.initValkey, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modCatalog, a.initCatalog, modules.Invisible(), modules.DependsOn(modPostgres, modValkey))
	m.Register(modSink, a.initSink, modules.Invisible(), modules.DependsOn(modClickHouse))

	m.Register(TargetEdge, a.initEdge, modules.DependsOn(modServer, modCatalog, modSink))
	// query is the first slice of the M3 read path (fixed queries, read keys).
	m.Register(TargetQuery, a.initQuery, modules.DependsOn(modServer, modClickHouse, modCatalog))
	m.Register(TargetAll, func(context.Context) (modules.Service, error) { return nil, nil }, modules.DependsOn(TargetEdge, TargetQuery))
	return a
}

// Targets lists implemented role targets.
func (a *App) Targets() []string { return a.mgr.Targets() }

// Run starts the configured targets and blocks until ctx is cancelled or a
// module fails.
func (a *App) Run(ctx context.Context) error {
	for _, t := range a.cfg.Target {
		if when, planned := PlannedTargets[t]; planned {
			return fmt.Errorf("role %q is part of the v2 architecture but not implemented yet (planned for %s); available now: %s",
				t, when, strings.Join(a.Targets(), ", "))
		}
	}
	return a.mgr.Run(ctx, a.cfg.Target)
}

func (a *App) initTelemetry(ctx context.Context) (modules.Service, error) {
	shutdown, wrap, err := otel.Setup(ctx, a.cfg.OTel)
	if err != nil {
		return nil, err
	}
	a.serverWrap = wrap
	return modules.ServiceFunc(func(ctx context.Context) error {
		<-ctx.Done()
		return shutdown(context.WithoutCancel(ctx))
	}), nil
}

func (a *App) initServer(context.Context) (modules.Service, error) {
	a.server = server.New(a.cfg.Server, a.logger, a.registry)
	if a.serverWrap != nil {
		a.server.SetWrapper(a.serverWrap)
	}
	server.RegisterMeta(a.server.API(), slices.Clone(a.cfg.Target))
	return nil, nil
}

func (a *App) initHTTP(context.Context) (modules.Service, error) {
	return a.server, nil
}

func (a *App) initPostgres(ctx context.Context) (modules.Service, error) {
	pool, err := pg.Connect(ctx, a.cfg.Postgres, "apilens")
	if err != nil {
		return nil, err
	}
	a.pool = pool
	a.server.AddReadinessCheck("postgres", func(ctx context.Context) error { return pool.Ping(ctx) })
	return closer(func() { pool.Close() }), nil
}

func (a *App) initClickHouse(ctx context.Context) (modules.Service, error) {
	conn, err := ch.Connect(ctx, a.cfg.ClickHouse)
	if err != nil {
		return nil, err
	}
	a.chConn = conn
	a.server.AddReadinessCheck("clickhouse", conn.Ping)
	return closer(func() { _ = conn.Close() }), nil
}

func (a *App) initValkey(ctx context.Context) (modules.Service, error) {
	if !a.cfg.Valkey.Enabled() {
		a.logger.Warn("valkey disabled: api key revocations propagate via cache TTL only")
		return nil, nil
	}
	client, err := cache.Connect(ctx, a.cfg.Valkey)
	if err != nil {
		return nil, err
	}
	a.valkey = client
	a.server.AddReadinessCheck("valkey", func(ctx context.Context) error { return cache.Ping(ctx, client) })
	return closer(client.Close), nil
}

func (a *App) initCatalog(context.Context) (modules.Service, error) {
	a.queries = db.New(a.pool)
	a.verifier = apikeys.NewVerifier(a.queries, apikeys.Options{
		Size: a.cfg.Ingest.KeyCacheSize, TTL: a.cfg.Ingest.KeyCacheTTL, NegativeTTL: a.cfg.Ingest.KeyNegativeTTL,
	}, a.logger, a.registry)
	a.apps = catalog.NewAppResolver(a.queries, a.cfg.Ingest.AppCacheTTL)
	if a.valkey == nil {
		return nil, nil
	}
	client, verifier := a.valkey, a.verifier
	return modules.ServiceFunc(func(ctx context.Context) error {
		cache.Subscribe(ctx, client, a.logger, apikeys.InvalidateChannel, verifier.Invalidate)
		return nil
	}), nil
}

func (a *App) initSink(context.Context) (modules.Service, error) {
	a.sink = pipeline.NewDirectSink(a.cfg.Sink, pipeline.ClickHouseInserters(a.chConn), a.logger, pipeline.NewMetrics(a.registry))
	return a.sink, nil
}

func (a *App) initEdge(context.Context) (modules.Service, error) {
	ingest.New(a.verifier, a.apps, a.sink, a.cfg.Ingest, a.logger, a.registry).Register(a.server.Mux())
	return nil, nil
}

func (a *App) initQuery(context.Context) (modules.Service, error) {
	api := a.server.API()
	api.UseMiddleware(query.AuthMiddleware(api, a.verifier))
	query.Register(api, query.NewService(a.chConn, a.queries))
	return nil, nil
}

// closer turns a cleanup func into a Service that runs it on shutdown, so
// pools close only after their dependents have stopped.
func closer(fn func()) modules.Service {
	return modules.ServiceFunc(func(ctx context.Context) error {
		<-ctx.Done()
		fn()
		return nil
	})
}
