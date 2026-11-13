// Package app is the composition root: it registers every module with the
// lifecycle manager and maps user-facing role targets onto them.
package app

import (
	"context"
	"crypto"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	authzed "github.com/authzed/authzed-go/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/access"
	controlplaneapi "github.com/apilens/apilens/internal/controlplane/api"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/emailchange"
	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/oidcprovider"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/recovery"
	"github.com/apilens/apilens/internal/identity/session"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/modules"
	"github.com/apilens/apilens/internal/platform/otel"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
)

// Module names. Visible ones are role targets (-target=...).
const (
	TargetAll      = "all"
	TargetEdge     = "edge"
	TargetQuery    = "query"
	TargetAPI      = "api"
	TargetIdentity = "identity"

	modTelemetry  = "telemetry"
	modServer     = "server"
	modHTTP       = "http"
	modPostgres   = "postgres"
	modClickHouse = "clickhouse"
	modValkey     = "valkey"
	modCatalog    = "catalog"
	modSink       = "sink"
	modJobs       = "jobs"
	modAuthz      = "authz"
	modRelay      = "outbox-relay"
	modAlerts     = "alerts"
	modExports    = "exports"
)

// PlannedTargets are roles of the target architecture that later milestones
// implement. Asking for one fails with a clear message instead of "unknown".
var PlannedTargets = map[string]string{
	"writer":    "M3 (Kafka consumers)",
	"processor": "M3 (endpoint discovery, error grouping)",
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
	privacy    *privacy.Resolver
	sink       *pipeline.DirectSink
	// workers is filled by modules during init; jobs runs them afterwards.
	workers *jobs.Registry
	jobs    *jobs.Client
	// spicedb and authz are nil when authz.endpoint is not set.
	spicedb *authzed.Client
	authz   *authz.Client
	// signingKeys holds identity's JWT signing keys (identity role only).
	signingKeys *keys.Manager
	// sessionAuth installs authn.Middleware once, for api, query and identity.
	sessionAuth sync.Once
	// denylist refuses access tokens of revoked sessions; set by
	// useSessionAuth and written by identity on revocation.
	denylist *authn.Denylist
	// limiter is shared by api and identity; built once by rateLimiter.
	limiter *ratelimit.Limiter
}

// New registers all modules.
func New(cfg *config.Config, logger *slog.Logger) *App {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	a := &App{cfg: cfg, logger: logger, registry: reg, mgr: modules.New(logger, cfg.Server.ShutdownTimeout), workers: jobs.NewRegistry()}

	m := a.mgr
	m.Register(modTelemetry, a.initTelemetry, modules.Invisible())
	m.Register(modServer, a.initServer, modules.Invisible(), modules.DependsOn(modTelemetry))
	// The listener starts after, and stops before, every module that
	// registers routes, so in-flight requests drain before the sink does.
	m.Register(modHTTP, a.initHTTP, modules.Invisible(), modules.DependsOn(modServer), modules.After(TargetEdge, TargetQuery, TargetAPI, TargetIdentity))
	m.Always(modHTTP)

	m.Register(modPostgres, a.initPostgres, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modClickHouse, a.initClickHouse, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modValkey, a.initValkey, modules.Invisible(), modules.DependsOn(modServer))
	m.Register(modCatalog, a.initCatalog, modules.Invisible(), modules.DependsOn(modPostgres, modValkey))
	m.Register(modSink, a.initSink, modules.Invisible(), modules.DependsOn(modClickHouse))
	// River client; its worker loop starts once every module has registered
	// workers and stops (draining in-flight jobs) after the HTTP listener.
	m.Register(modJobs, a.initJobs, modules.Invisible(), modules.DependsOn(modPostgres))
	m.Register(modAuthz, a.initAuthz, modules.Invisible(), modules.DependsOn(modServer, modValkey))
	// The outbox relay syncs Postgres to SpiceDB: a periodic job plus a
	// NOTIFY listener for low latency. The hourly reconciler job repairs
	// drift between the two.
	m.Register(modRelay, a.initRelay, modules.Invisible(), modules.DependsOn(modPostgres, modJobs, modAuthz))

	m.Register(TargetEdge, a.initEdge, modules.DependsOn(modServer, modValkey, modCatalog, modSink))
	// query is the first slice of the M3 read path (fixed queries; user
	// sessions authorized by SpiceDB, or read keys).
	m.Register(TargetQuery, a.initQuery, modules.DependsOn(modServer, modPostgres, modClickHouse, modCatalog, modAuthz, modJobs))
	m.Register(TargetAPI, a.initAPI, modules.DependsOn(modServer, modPostgres, modValkey, modAuthz, modJobs))
	// identity runs the M2 job workers (email, outbox relay, authz
	// reconciler); the M4 worker role will too.
	m.Register(TargetIdentity, a.initIdentity, modules.DependsOn(modServer, modPostgres, modValkey, modJobs, modRelay))
	// Alert rule evaluation is a periodic job over ClickHouse. Until the M4
	// worker role exists it runs only in the all-in-one process, the one
	// role that has both ClickHouse and the job workers.
	m.Register(modAlerts, a.initAlerts, modules.Invisible(), modules.DependsOn(modPostgres, modClickHouse, modCatalog, modJobs))
	// Request log exports are River jobs over ClickHouse on their own queue;
	// like alerts they are worked by the all-in-one process until the M4
	// worker role exists. query only enqueues them and serves the files.
	m.Register(modExports, a.initExports, modules.Invisible(), modules.DependsOn(modPostgres, modClickHouse, modJobs))
	m.Register(TargetAll, func(context.Context) (modules.Service, error) { return nil, nil },
		modules.DependsOn(TargetEdge, TargetQuery, TargetAPI, TargetIdentity, modAlerts, modExports))
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
	a.warnEmail()
	return a.mgr.Run(ctx, a.cfg.Target)
}

// emailTargets are the roles that send transactional email.
var emailTargets = []string{TargetAll, TargetAPI, TargetIdentity}

// warnEmail flags, once at startup, that a role which sends email is running
// with the log provider: messages are logged, not delivered.
func (a *App) warnEmail() {
	if !a.cfg.Email.LogOnly() || !slices.ContainsFunc(a.cfg.Target, func(t string) bool { return slices.Contains(emailTargets, t) }) {
		return
	}
	a.logger.Warn("email provider is log: sign-in codes and invitations are written to the log, not delivered; set APILENS_EMAIL__PROVIDER=smtp (with APILENS_EMAIL__HOST and APILENS_EMAIL__FROM) to send them")
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
		a.logger.Warn("valkey disabled: api key revocations propagate via cache TTL only, and revoked sessions' access tokens stay valid until they expire")
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
	// Apps come from the SDK: the resolver creates the apps SDKs name,
	// through the same code path as a project's default app.
	a.apps = catalog.NewAppResolver(a.queries, a.cfg.Ingest.AppCacheTTL).WithProvisioner(appsvc.NewProvisioner(
		a.pool, audit.New(a.pool), appsvc.Limits{MaxApps: a.cfg.Ingest.MaxAppsPerProject, MaxNewPerHour: a.cfg.Ingest.MaxNewAppsPerHour},
	))
	a.privacy = privacy.NewResolver(a.queries, a.cfg.Ingest.AppCacheTTL)
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

func (a *App) initJobs(context.Context) (modules.Service, error) {
	client, err := jobs.New(a.pool, a.cfg.Jobs, a.workers, a.cfg.Server.ShutdownTimeout, a.logger, a.registry)
	if err != nil {
		return nil, err
	}
	a.jobs = client
	return client, nil
}

func (a *App) initAuthz(context.Context) (modules.Service, error) {
	if !a.cfg.Authz.Enabled() {
		a.logger.Warn("authz disabled (authz.endpoint is not set): permission checks deny and the outbox is not relayed to SpiceDB")
		return nil, nil
	}
	client, err := spicedb.Connect(a.cfg.Authz)
	if err != nil {
		return nil, err
	}
	var tokens authz.TokenStore
	if a.valkey != nil {
		tokens = authz.NewValkeyTokens(a.valkey)
	}
	a.spicedb = client
	a.authz = authz.New(client, tokens, authz.Options{CacheTTL: a.cfg.Authz.CacheTTL}, a.logger, a.registry)
	return closer(func() { _ = client.Close() }), nil
}

// initRelay registers the outbox relay and authz reconcile jobs and runs the
// relay's NOTIFY listener.
func (a *App) initRelay(context.Context) (modules.Service, error) {
	if a.spicedb == nil {
		return nil, nil
	}
	relay := outbox.NewRelay(a.pool, a.spicedb, a.authz, outbox.RelayOptions{}, a.logger, a.registry)
	jobs.Register(a.workers, outbox.NewRelayWorker(relay))
	a.workers.Periodic(outbox.RelayInterval, outbox.RelayArgs{})
	reconciler := outbox.NewReconciler(a.pool, a.spicedb, a.authz, outbox.ReconcileOptions{}, a.logger, a.registry)
	jobs.Register(a.workers, outbox.NewReconcileWorker(reconciler))
	a.workers.Periodic(outbox.ReconcileInterval, outbox.ReconcileArgs{})
	if !a.cfg.Jobs.Enabled {
		return nil, nil
	}
	return modules.ServiceFunc(relay.Listen), nil
}

// initAlerts registers the periodic alert rule evaluation, heartbeat
// uptime and HTTP health check jobs and the notification jobs they enqueue
// (email, Slack, Teams, webhook).
func (a *App) initAlerts(context.Context) (modules.Service, error) {
	// Channel configs are sealed with the identity key-encryption key;
	// without one in this process deliveries are dropped.
	var sealer *keys.Sealer
	if a.cfg.Identity.KeyEncryptionKey != "" {
		kek, err := a.cfg.Identity.KEK()
		if err != nil {
			return nil, err
		}
		if sealer, err = keys.NewSealer(kek); err != nil {
			return nil, err
		}
	}
	notifier := alerts.NewNotifier(a.pool, a.jobs, alerts.NotifierOptions{
		PublicUIURL: a.cfg.Identity.PublicUIURL, Sealer: sealer,
	}, a.logger, a.registry)
	jobs.Register(a.workers, alerts.NewNotifyWorker(notifier))
	jobs.Register(a.workers, alerts.NewDeliverWorker(notifier))
	evaluator := alerts.NewEvaluator(a.chConn, a.pool, a.logger, a.registry).WithNotifications(a.jobs)
	jobs.Register(a.workers, alerts.NewEvaluateWorker(evaluator, a.logger))
	a.workers.Periodic(alerts.EvaluateInterval, alerts.EvaluateArgs{})
	uptime := alerts.NewUptimeChecker(a.pool, a.logger, a.registry).WithNotifications(a.jobs)
	jobs.Register(a.workers, alerts.NewUptimeWorker(uptime, a.logger))
	a.workers.Periodic(alerts.UptimeInterval, alerts.UptimeArgs{})
	prober := alerts.NewProber(alerts.ProberOptions{AllowPrivateNetworks: a.cfg.Alerts.HealthChecksAllowPrivate})
	health := alerts.NewHealthChecker(a.pool, prober, a.logger, a.registry).WithPrivacy(a.privacy).WithNotifications(a.jobs)
	jobs.Register(a.workers, alerts.NewHealthChecksWorker(health, a.logger))
	a.workers.Periodic(alerts.HealthCheckInterval, alerts.HealthChecksArgs{})
	return nil, nil
}

// initExports registers the request log export jobs on their own queue.
func (a *App) initExports(context.Context) (modules.Service, error) {
	store, err := query.NewLocalExportStore(a.cfg.Exports.Dir)
	if err != nil {
		return nil, err
	}
	a.workers.Queue(query.ExportQueue, query.ExportQueueWorkers)
	jobs.Register(a.workers, query.NewExportWorker(a.chConn, a.pool, store, a.logger))
	jobs.Register(a.workers, query.NewExportCleanupWorker(a.pool, store, a.logger))
	a.workers.Periodic(query.ExportCleanupInterval, query.ExportCleanupArgs{})
	return nil, nil
}

func (a *App) initEdge(context.Context) (modules.Service, error) {
	edge := ingest.New(a.verifier, a.apps, a.sink, a.cfg.Ingest, a.logger, a.registry).WithPrivacy(a.privacy).WithMetadata(a.queries).
		WithCapture(capture.NewResolver(a.queries, a.cfg.Ingest.AppCacheTTL))
	// Config validation guarantees Valkey when a project quota is set.
	// Per-key rate limits (api_keys.rate_limit_per_minute) share the same
	// buckets, so the quota is installed whenever Valkey is; without Valkey
	// they are not enforced.
	if a.valkey != nil {
		edge.WithQuota(ingest.NewValkeyQuota(a.valkey, a.cfg.Ingest.Quota))
	}
	// Without Valkey heartbeats are neither rate-limited nor mirrored to
	// the last-seen key; Postgres stays the source of truth.
	var heartbeats ingest.HeartbeatCache
	if a.valkey != nil {
		heartbeats = ingest.NewValkeyHeartbeats(a.valkey)
	}
	edge.WithHeartbeat(a.queries, heartbeats)
	edge.WithKeyApps(a.queries)
	// Without Valkey the per-app health counters are not kept; Prometheus
	// still has the totals.
	if a.valkey != nil {
		stats := ingest.NewValkeyStats(a.valkey)
		edge.WithStats(stats).WithAppRejections(stats)
	}
	edge.Register(a.server.Mux())
	ingest.RegisterOpenAPI(a.server.API())
	return nil, nil
}

func (a *App) initQuery(context.Context) (modules.Service, error) {
	api := a.server.API()
	a.useSessionAuth()
	// Session callers name the project with ?project= (or in the path) and
	// need project.view. With authz disabled session reads fail closed; read
	// keys still work on the ?project= operations.
	guard := a.guard()
	api.UseMiddleware(query.AuthMiddleware(api, a.verifier, guard))
	svc := query.NewService(a.chConn, a.queries).WithQuota(a.cfg.Ingest.Quota)
	if a.valkey != nil {
		svc.WithIngestStats(ingest.NewValkeyStats(a.valkey))
	}
	store, err := query.NewLocalExportStore(a.cfg.Exports.Dir)
	if err != nil {
		return nil, err
	}
	svc.WithExports(a.pool, a.jobs, store)
	// Notification channel configs are sealed with the identity
	// key-encryption key; without one in this process channel writes and
	// test notifications answer 503.
	var sealer *keys.Sealer
	if a.cfg.Identity.KeyEncryptionKey != "" {
		kek, err := a.cfg.Identity.KEK()
		if err != nil {
			return nil, err
		}
		if sealer, err = keys.NewSealer(kek); err != nil {
			return nil, err
		}
	}
	svc.WithAlerts(a.pool, sealer, query.NewTestSender(a.pool, a.jobs, nil, a.cfg.Identity.PublicUIURL))
	svc.WithHealthCheckPrivateNetworks(a.cfg.Alerts.HealthChecksAllowPrivate)
	svc.WithAudit(a.pool, audit.New(a.pool))
	query.Register(api, svc, guard)
	return nil, nil
}

func (a *App) initAPI(context.Context) (modules.Service, error) {
	a.useSessionAuth()
	if !a.cfg.IdentityEnabled() {
		// With identity in this process, initIdentity installs it.
		a.server.Use(audit.Middleware)
	}
	limiter, err := a.rateLimiter()
	if err != nil {
		return nil, err
	}
	orgService := orgs.New(a.pool, audit.New(a.pool))
	// SSO client secrets are sealed with the identity key-encryption key;
	// without one in this process saving a connection answers
	// internal_error.
	var sealer *keys.Sealer
	if a.cfg.Identity.KeyEncryptionKey != "" {
		kek, err := a.cfg.Identity.KEK()
		if err != nil {
			return nil, err
		}
		if sealer, err = keys.NewSealer(kek); err != nil {
			return nil, err
		}
	}
	appService := appsvc.NewService(a.pool, audit.New(a.pool)).OnChange(func(projectID uuid.UUID) {
		// This process sees the change at once; other edges within the app
		// cache TTL.
		if a.apps != nil {
			a.apps.Forget(projectID)
		}
	})
	var appRejections controlplaneapi.AppRejectionReader
	if a.valkey != nil {
		appRejections = ingest.NewValkeyStats(a.valkey)
	}
	controlplaneapi.Register(a.server.API(), controlplaneapi.Deps{
		Orgs:          orgService,
		Members:       orgService,
		Apps:          appService,
		AppRejections: appRejections,
		Access:        access.New(a.pool),
		Audit:         auditlog.New(a.pool, a.checker()),
		Projects:      projects.New(a.pool).WithAudit(audit.New(a.pool)),
		APIKeys:       apikeys.NewService(a.pool, audit.New(a.pool), a.invalidateAPIKey, a.logger).WithMaxKeys(a.cfg.Ingest.MaxKeysPerProject),
		Privacy:       privacy.NewService(a.pool).WithAudit(audit.New(a.pool)),
		Capture:       capture.NewService(a.pool, audit.New(a.pool)),
		Context:       usercontext.New(a.pool, a.checker()),
		Guard:         a.guard(),
		Limiter:       limiter,
		Limits:        a.cfg.Identity.RateLimits,
		Logger:        a.logger,

		SensitiveActionMaxAge: a.cfg.Identity.SensitiveActionMaxAge,

		// Invitation emails are enqueued here and sent by the role that
		// runs the email worker (identity).
		Invitations: orgs.NewInvitations(a.pool, audit.New(a.pool), a.jobs),

		SSO:    orgs.NewSSOConnections(a.pool, audit.New(a.pool), sealer),
		Issuer: a.cfg.Identity.Issuer,
	})
	return nil, nil
}

// invalidateAPIKey drops a revoked key hash from this process's verifier and,
// through Valkey pub/sub, from every other process's (the edge and query
// roles subscribe in initCatalog). Without Valkey a revocation reaches other
// processes when their key cache TTL expires.
func (a *App) invalidateAPIKey(ctx context.Context, hash string) error {
	if a.verifier != nil {
		a.verifier.Invalidate(hash)
	}
	if a.valkey == nil {
		return nil
	}
	return cache.Publish(ctx, a.valkey, apikeys.InvalidateChannel, hash)
}

// checker returns the authz client permission checks go through. With authz
// disabled it is a client whose every check denies with authz_unavailable.
func (a *App) checker() *authz.Client {
	if a.authz == nil {
		return authz.New(nil, nil, authz.Options{}, a.logger, nil)
	}
	return a.authz
}

// guard returns the authz.Guard operations use to authorize requests on an
// organization or project named in their path.
func (a *App) guard() *authz.Guard {
	return authz.NewGuard(a.checker(), authz.NewPGResolver(a.pool), authz.GuardOptions{}, a.logger)
}

func (a *App) initIdentity(ctx context.Context) (modules.Service, error) {
	signingKeys, err := newKeyManager(a.pool, a.cfg, a.logger)
	if err != nil {
		return nil, err
	}
	// A fresh database gets its first signing key here.
	if _, _, err := signingKeys.Ensure(ctx); err != nil {
		return nil, fmt.Errorf("identity: signing keys: %w", err)
	}
	a.signingKeys = signingKeys
	if err := a.registerEmailWorker(); err != nil {
		return nil, err
	}
	a.server.Use(identity.Middleware(a.cfg.Identity))
	a.server.Use(audit.Middleware)
	// /api/v1/users/me and /api/v1/users/me/sessions need a user session;
	// install it before any identity route is registered.
	a.useSessionAuth()
	identity.Register(a.server.API())
	identity.RegisterJWKS(a.server.Mux(), signingKeys, a.logger)
	identity.RegisterProviders(a.server.API(), a.cfg.Identity)
	limiter, err := a.rateLimiter()
	if err != nil {
		return nil, err
	}
	issuer, err := token.New(signingKeys, token.Options{Issuer: a.cfg.Identity.Issuer, TTL: a.cfg.Identity.AccessTokenTTL})
	if err != nil {
		return nil, err
	}
	sessions, err := session.New(a.pool, issuer, session.Options{
		RefreshTTL:      a.cfg.Identity.RefreshTokenTTL,
		RefreshTTLShort: a.cfg.Identity.RefreshTokenTTLShort,
		Jobs:            a.jobs,
		AccessTTL:       a.cfg.Identity.AccessTokenTTL,
		Denylist:        a.denylist,
	}, a.logger)
	if err != nil {
		return nil, err
	}
	identity.NewSessions(a.cfg.Identity, sessions, limiter, a.logger).Register(a.server.API())
	handoff := identity.NewValkeyHandoffStore(a.valkey)
	ssoEnforcement := identity.NewSSOEnforcement(identitydb.New(a.pool), a.cfg.Identity.Issuer)
	identity.NewOAuth(a.cfg.Identity, identity.NewValkeyOAuthStateStore(a.valkey), limiter, a.logger).
		WithSignIn(identity.OAuthSignInDeps{
			Users:    identity.NewPGSignInUsers(a.pool),
			Sessions: sessions,
			PreAuth:  identity.NewValkeyPreAuthStore(a.valkey),
			Handoff:  handoff,
			Audit:    audit.New(a.pool),

			Identities: identity.NewPGOAuthIdentities(a.pool),
			Jobs:       a.jobs,
			SSO:        ssoEnforcement,
		}).Register(a.server.API())
	identity.NewHandoff(a.cfg.Identity, handoff, limiter, a.logger).Register(a.server.API())
	identity.NewConnectedAccounts(identity.ConnectedAccountsDeps{
		Identities: identity.NewPGOAuthIdentities(a.pool),
		Jobs:       a.jobs,
	}, a.logger).Register(a.server.API())
	identity.NewEmailStart(a.cfg.Identity, identity.EmailStartDeps{
		Tokens: emailauth.New(emailauth.NewStore(a.pool), emailauth.Options{}),
		Users:  identitydb.New(a.pool),
		Jobs:   a.jobs,
		Audit:  audit.New(a.pool),
		SSO:    ssoEnforcement,
	}, limiter, a.logger).Register(a.server.API())
	identity.NewSSOLookup(a.cfg.Identity, identitydb.New(a.pool), limiter, a.logger).Register(a.server.API())
	// Invitation links live under /api/v1/auth, so the identity role serves
	// them; accepting writes the membership through the outbox.
	controlplaneapi.NewInvitationLinks(orgs.NewInvitations(a.pool, audit.New(a.pool), a.jobs), limiter,
		ratelimit.Rate(a.cfg.Identity.RateLimits.InvitationLookupPerIP), a.logger).Register(a.server.API())
	identity.NewEmailVerify(a.cfg.Identity, identity.EmailVerifyDeps{
		Codes:    emailauth.New(emailauth.NewStore(a.pool), emailauth.Options{}),
		Users:    identity.NewPGSignInUsers(a.pool),
		Sessions: sessions,
		PreAuth:  identity.NewValkeyPreAuthStore(a.valkey),
		Audit:    audit.New(a.pool),
	}, limiter, a.logger).Register(a.server.API())
	// Until memberships exist (#276) no user owns an organization, so
	// nothing blocks a deletion.
	accounts := account.New(a.pool, account.NoMemberships{})
	identity.NewAccount(accounts, a.logger).Register(a.server.API())
	identity.NewOnboarding(accounts, a.logger).Register(a.server.API())
	kek, err := a.cfg.Identity.KEK()
	if err != nil {
		return nil, err
	}
	twoFactor, err := twofactor.New(a.pool, kek, a.jobs)
	if err != nil {
		return nil, err
	}
	identity.NewTwoFactor(twoFactor, a.logger).Register(a.server.API())
	sealer, err := keys.NewSealer(kek)
	if err != nil {
		return nil, err
	}
	identity.NewSSO(a.cfg.Identity, identity.NewValkeyOAuthStateStore(a.valkey), identity.SSODeps{
		Connections: identitydb.New(a.pool),
		Sealer:      sealer,
		Users:       identity.NewPGSignInUsers(a.pool),
		Memberships: orgs.New(a.pool, audit.New(a.pool)),
		Sessions:    sessions,
		PreAuth:     identity.NewValkeyPreAuthStore(a.valkey),
		Handoff:     handoff,
		Audit:       audit.New(a.pool),
	}, limiter, a.logger).Register(a.server.API())
	identity.NewTwoFactorExchange(identity.TwoFactorExchangeDeps{
		PreAuth:   identity.NewValkeyPreAuthStore(a.valkey),
		TwoFactor: twoFactor,
		Users:     identity.NewPGSignInUsers(a.pool),
		Sessions:  sessions,
		Audit:     audit.New(a.pool),
	}, a.logger).Register(a.server.API())
	codes := emailauth.New(emailauth.NewStore(a.pool), emailauth.Options{})
	identity.NewEmailChange(emailchange.New(a.pool, codes, a.jobs), a.logger).Register(a.server.API())
	rp, err := passkey.NewRelyingParty(a.cfg.Identity.WebAuthn)
	if err != nil {
		return nil, err
	}
	identity.NewPasskeys(identity.PasskeysDeps{
		Registrar: passkey.NewRegistration(rp, passkey.NewValkeyChallengeStore(a.valkey), a.pool),
		Manager:   passkey.NewManager(a.pool),
		Users:     identitydb.New(a.pool),
		Jobs:      a.jobs,
	}, a.logger).Register(a.server.API())
	identity.NewPasskeyLogin(a.cfg.Identity, identity.PasskeyLoginDeps{
		Login:    passkey.NewLogin(rp, passkey.NewValkeyChallengeStore(a.valkey), a.pool),
		Users:    identity.NewPGSignInUsers(a.pool),
		Sessions: sessions,
		Audit:    audit.New(a.pool),
	}, limiter, a.logger).Register(a.server.API())
	identity.NewReauth(a.cfg.Identity, identity.ReauthDeps{
		Users:     identitydb.New(a.pool),
		Sessions:  sessions,
		Passkeys:  passkey.NewLogin(rp, passkey.NewValkeyChallengeStore(a.valkey), a.pool),
		TwoFactor: twoFactor,
		Codes:     codes,
		Jobs:      a.jobs,
		Audit:     audit.New(a.pool),
		SSO:       ssoEnforcement,
	}, limiter, a.logger).Register(a.server.API())
	identity.NewRestore(a.cfg.Identity, accounts, codes, limiter, a.logger).Register(a.server.API())
	recoverySvc := recovery.New(a.pool, a.jobs, recovery.Options{Delay: a.cfg.Identity.RecoveryDelay})
	identity.NewRecovery(a.cfg.Identity, recoverySvc, sessions, limiter, a.logger).Register(a.server.API())
	if a.cfg.Identity.OIDCProvider.Enabled {
		if err := a.mountOIDCProvider(signingKeys, kek); err != nil {
			return nil, err
		}
	}
	// Deleted accounts are purged hourly once their grace period has passed.
	jobs.Register(a.workers, account.NewPurgeWorker(a.pool, a.logger))
	a.workers.Periodic(account.PurgeInterval, account.PurgeArgs{})
	return modules.ServiceFunc(signingKeys.Run), nil
}

// rateLimiter returns the process-wide Valkey-backed limiter, building it on
// first use so api and identity share one instance.
func (a *App) rateLimiter() (*ratelimit.Limiter, error) {
	if a.limiter != nil {
		return a.limiter, nil
	}
	l, err := ratelimit.New(a.valkey, a.logger, a.cfg.Identity.RateLimits.TrustedProxies)
	if err != nil {
		return nil, err
	}
	a.limiter = l
	return l, nil
}

// mountOIDCProvider serves identity as an OpenID provider (discovery,
// /oauth/*) and the authorization-request endpoints the UI sign-in uses.
func (a *App) mountOIDCProvider(signingKeys *keys.Manager, kek []byte) error {
	storage, err := oidcprovider.NewStorage(a.pool, signingKeys, oidcprovider.Options{
		Issuer:          a.cfg.Identity.Issuer,
		PublicUIURL:     a.cfg.Identity.PublicUIURL,
		AccessTokenTTL:  a.cfg.Identity.AccessTokenTTL,
		RefreshTokenTTL: a.cfg.Identity.RefreshTokenTTL,
		CryptoKey:       oidcprovider.DeriveCryptoKey(kek),
	})
	if err != nil {
		return err
	}
	provider, err := oidcprovider.New(storage)
	if err != nil {
		return fmt.Errorf("identity: oidc provider: %w", err)
	}
	provider.Mount(a.server.Mux())
	identity.NewOIDCRequests(storage, a.logger).Register(a.server.API())
	return nil
}

// useSessionAuth installs the user-session middleware on the typed API. With
// identity in this process its keys are read in-process; otherwise they come
// from identity's JWKS, fetched lazily and cached.
func (a *App) useSessionAuth() {
	a.sessionAuth.Do(func() {
		var src authn.KeySource
		if a.cfg.IdentityEnabled() {
			// a.signingKeys is set by initIdentity, which runs before the
			// listener starts serving requests.
			src = authn.KeySourceFunc(func(ctx context.Context, kid string) (crypto.PublicKey, error) {
				if a.signingKeys == nil {
					return nil, authn.ErrUnavailable
				}
				return localPublicKey(a.signingKeys.All(), kid)
			})
		} else {
			src = authn.NewJWKS(strings.TrimRight(a.cfg.Identity.Issuer, "/")+identity.JWKSPath, authn.JWKSOptions{})
		}
		// a.valkey is nil when Valkey is disabled: the denylist then
		// covers only revocations made in this process.
		a.denylist = authn.NewDenylist(a.valkey, a.cfg.Identity.AccessTokenTTL, a.logger)
		api := a.server.API()
		verifier := authn.NewSessionVerifier(src, a.cfg.Identity.Issuer, nil).WithDenylist(a.denylist)
		api.UseMiddleware(authn.Middleware(api, verifier))
	})
}

// localPublicKey returns the public half of the published key named kid.
func localPublicKey(published []keys.Key, kid string) (crypto.PublicKey, error) {
	for _, k := range published {
		if k.KID == kid && k.Alg == keys.AlgRS256 {
			return k.Signer().Public(), nil
		}
	}
	return nil, authn.ErrUnknownKey
}

// newKeyManager builds the signing key manager over pool, sealing private
// keys with identity.key_encryption_key.
func newKeyManager(pool *pgxpool.Pool, cfg *config.Config, logger *slog.Logger) (*keys.Manager, error) {
	kek, err := cfg.Identity.KEK()
	if err != nil {
		return nil, err
	}
	store, err := keys.NewStore(identitydb.New(pool), kek)
	if err != nil {
		return nil, err
	}
	return keys.NewManager(pool, store, keys.ManagerOptions{RetiredWindow: cfg.Identity.RefreshTokenTTL}, logger), nil
}

// registerEmailWorker registers the email.send worker with the configured
// provider. Other roles only enqueue.
func (a *App) registerEmailWorker() error {
	renderer, err := email.DefaultRenderer(email.WithPublicUIURL(a.cfg.Identity.PublicUIURL))
	if err != nil {
		return err
	}
	sender, err := email.NewSender(a.cfg.Email, a.logger)
	if err != nil {
		return err
	}
	jobs.Register(a.workers, email.NewWorker(renderer, sender, a.logger, email.NewMetrics(a.registry)))
	return nil
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
