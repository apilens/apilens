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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/authz"
	controlplaneapi "github.com/apilens/apilens/internal/controlplane/api"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
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

	m.Register(TargetEdge, a.initEdge, modules.DependsOn(modServer, modCatalog, modSink))
	// query is the first slice of the M3 read path (fixed queries, read keys).
	m.Register(TargetQuery, a.initQuery, modules.DependsOn(modServer, modClickHouse, modCatalog))
	m.Register(TargetAPI, a.initAPI, modules.DependsOn(modServer, modPostgres, modValkey))
	// identity runs the M2 job workers (email, outbox relay, authz
	// reconciler); the M4 worker role will too.
	m.Register(TargetIdentity, a.initIdentity, modules.DependsOn(modServer, modPostgres, modValkey, modJobs, modRelay))
	m.Register(TargetAll, func(context.Context) (modules.Service, error) { return nil, nil },
		modules.DependsOn(TargetEdge, TargetQuery, TargetAPI, TargetIdentity))
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

func (a *App) initEdge(context.Context) (modules.Service, error) {
	ingest.New(a.verifier, a.apps, a.sink, a.cfg.Ingest, a.logger, a.registry).Register(a.server.Mux())
	return nil, nil
}

func (a *App) initQuery(context.Context) (modules.Service, error) {
	api := a.server.API()
	a.useSessionAuth()
	api.UseMiddleware(query.AuthMiddleware(api, a.verifier))
	query.Register(api, query.NewService(a.chConn, a.queries))
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
	controlplaneapi.Register(a.server.API(), controlplaneapi.Deps{
		Orgs:    orgService,
		Members: orgService,
		Limiter: limiter,
		Limits:  a.cfg.Identity.RateLimits,
		Logger:  a.logger,
	})
	return nil, nil
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
	identity.NewOAuth(a.cfg.Identity, identity.NewValkeyOAuthStateStore(a.valkey), limiter, a.logger).
		WithSignIn(identity.OAuthSignInDeps{
			Users:    identity.NewPGSignInUsers(a.pool),
			Sessions: sessions,
			PreAuth:  identity.NewValkeyPreAuthStore(a.valkey),
			Handoff:  handoff,
			Audit:    audit.New(a.pool),

			Identities: identity.NewPGOAuthIdentities(a.pool),
			Jobs:       a.jobs,
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
	}, limiter, a.logger).Register(a.server.API())
	identity.NewSSOLookup(a.cfg.Identity, identitydb.New(a.pool), limiter, a.logger).Register(a.server.API())
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
	kek, err := a.cfg.Identity.KEK()
	if err != nil {
		return nil, err
	}
	twoFactor, err := twofactor.New(a.pool, kek, a.jobs)
	if err != nil {
		return nil, err
	}
	identity.NewTwoFactor(twoFactor, a.logger).Register(a.server.API())
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
