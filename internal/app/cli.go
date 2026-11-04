package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/authz"
	authzclient "github.com/apilens/apilens/internal/authz"
	controlplaneapi "github.com/apilens/apilens/internal/controlplane/api"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/oidcprovider"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/buildinfo"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	applog "github.com/apilens/apilens/internal/platform/log"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
)

const usage = `apilens — API observability platform (one binary, many roles)

Usage:
  apilens [-target=all] [-config.file=path]   run roles (comma-separated targets)
  apilens migrate [-only=postgres,clickhouse,authz]
                                              apply Postgres (incl. River jobs) and ClickHouse
                                              migrations and the SpiceDB schema (when
                                              authz.endpoint is set)
  apilens seed [flags]                        create a dev org/project/app and print an ingest key
  apilens identity rotate-key                 activate a new token signing key; the previous
                                              one stays published until its tokens expire
  apilens authz reconcile [-dry-run]          repair drift between Postgres and SpiceDB now
                                              (the identity role also runs it hourly)
  apilens identity create-client [flags]      register a client of the built-in OIDC provider
                                              and print its id and secret
  apilens healthcheck [-url=...]              exit 0 if the readiness endpoint answers 200
  apilens openapi                             print the OpenAPI 3.1 document
  apilens version                             print build information

Targets: %s
Planned: %s

Configuration: defaults < YAML file < APILENS_* env (nested with __) < flags.
`

// Main runs the CLI and returns the process exit code.
func Main(args []string, stdout, stderr io.Writer, environ []string) int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "":
		err = runServe(ctx, args, stderr, environ)
	case "migrate":
		err = runMigrate(ctx, args, stderr, environ)
	case "seed":
		err = runSeed(ctx, args, stdout, stderr, environ)
	case "identity":
		err = runIdentity(ctx, args, stdout, stderr, environ)
	case "authz":
		err = runAuthz(ctx, args, stdout, stderr, environ)
	case "healthcheck":
		err = runHealthcheck(ctx, args, stderr)
	case "openapi":
		err = runOpenAPI(stdout)
	case "version":
		err = json.NewEncoder(stdout).Encode(buildinfo.Get())
	case "help", "-h", "--help":
		printUsage(stdout)
	default:
		printUsage(stderr)
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			_, _ = fmt.Fprintln(stderr, "apilens:", err)
		}
		return 1
	}
	return 0
}

func printUsage(w io.Writer) {
	planned := slices.Sorted(maps.Keys(PlannedTargets))
	_, _ = fmt.Fprintf(w, usage, strings.Join([]string{TargetAll, TargetEdge, TargetQuery, TargetAPI, TargetIdentity}, ", "), strings.Join(planned, ", "))
}

// loadConfig parses the shared flags and returns the merged config.
func loadConfig(fs *flag.FlagSet, args []string, environ []string, stderr io.Writer) (*config.Config, *slog.Logger, error) {
	configFile := fs.String("config.file", "", "YAML config file")
	target := fs.String("target", "", "comma-separated role targets (default from config: all)")
	logLevel := fs.String("log.level", "", "debug|info|warn|error")
	addr := fs.String("server.addr", "", "HTTP listen address")
	if err := fs.Parse(args); err != nil {
		return nil, nil, err
	}
	overrides := map[string]any{}
	if *target != "" {
		overrides["target"] = splitComma(*target)
	}
	if *logLevel != "" {
		overrides["log.level"] = *logLevel
	}
	if *addr != "" {
		overrides["server.addr"] = *addr
	}
	cfg, err := config.Load(*configFile, environ, overrides)
	if err != nil {
		return nil, nil, err
	}
	return cfg, applog.New(stderr, cfg.Log.Level, cfg.Log.Format), nil
}

func runServe(ctx context.Context, args []string, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { printUsage(stderr); fs.PrintDefaults() }
	cfg, logger, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	// `-target=migrate` is accepted for parity with the other one-shot roles.
	if len(cfg.Target) == 1 && cfg.Target[0] == "migrate" {
		return migrate(ctx, cfg, logger, nil)
	}
	logger.Info("apilens starting", "version", buildinfo.Get().Version, "targets", cfg.Target)
	return New(cfg, logger).Run(ctx)
}

func runMigrate(ctx context.Context, args []string, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	only := fs.String("only", "", "comma-separated subset to apply: "+strings.Join(migrateSteps, ", ")+" (default: all)")
	cfg, logger, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	steps := splitComma(*only)
	for _, s := range steps {
		if !slices.Contains(migrateSteps, s) {
			return fmt.Errorf("migrate: unknown -only step %q (want %s)", s, strings.Join(migrateSteps, ", "))
		}
	}
	return migrate(ctx, cfg, logger, steps)
}

// migrateSteps are the parts of `apilens migrate`, in the order they run.
var migrateSteps = []string{"postgres", "clickhouse", "authz"}

// migrate applies the selected steps (all when steps is empty). The authz
// step writes the SpiceDB schema and is skipped when authz.endpoint is unset.
func migrate(ctx context.Context, cfg *config.Config, logger *slog.Logger, steps []string) error {
	want := func(step string) bool { return len(steps) == 0 || slices.Contains(steps, step) }
	if want("postgres") {
		pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-migrate")
		if err != nil {
			return err
		}
		err = migrations.UpPostgres(ctx, pool, logger)
		if err == nil {
			err = migrations.UpRiver(ctx, pool, logger)
		}
		pool.Close()
		if err != nil {
			return err
		}
	}
	if want("clickhouse") {
		if err := migrations.UpClickHouse(ctx, cfg.ClickHouse, logger); err != nil {
			return err
		}
	}
	if want("authz") {
		if !cfg.Authz.Enabled() {
			logger.Info("authz.endpoint not set; skipping the SpiceDB schema")
			return nil
		}
		client, err := spicedb.Connect(cfg.Authz)
		if err != nil {
			return err
		}
		defer func() { _ = client.Close() }()
		return spicedb.ApplySchema(ctx, client, authz.Schema, logger)
	}
	return nil
}

func runSeed(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens seed", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o bootstrap.Options
	fs.StringVar(&o.OrgSlug, "org-slug", "dev", "organization slug")
	fs.StringVar(&o.ProjectSlug, "project-slug", "dev", "project slug")
	fs.StringVar(&o.AppSlug, "app-slug", "default", "app slug")
	fs.StringVar(&o.Environment, "environment", "production", "environment name")
	fs.StringVar(&o.KeyName, "key-name", "seed", "name of the issued API key")
	cfg, _, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-seed")
	if err != nil {
		return err
	}
	defer pool.Close()
	res, err := bootstrap.Seed(ctx, pool, o)
	if err != nil {
		return fmt.Errorf("seed: %w", err)
	}
	return json.NewEncoder(stdout).Encode(res) //nolint:gosec // G117: printing the new key once is the point of seed
}

// runIdentity runs the `apilens identity <command>` operator commands.
func runIdentity(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	sub := ""
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "rotate-key":
		return runRotateKey(ctx, args, stdout, stderr, environ)
	case "create-client":
		return runCreateClient(ctx, args, stdout, stderr, environ)
	default:
		return fmt.Errorf("identity: unknown command %q (want rotate-key or create-client)", sub)
	}
}

// runCreateClient registers an OAuth/OIDC client of the built-in provider
// and prints its id and secret (shown once).
func runCreateClient(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens identity create-client", flag.ContinueOnError)
	fs.SetOutput(stderr)
	name := fs.String("name", "", "display name shown on the sign-in page")
	redirects := fs.String("redirect-uris", "", "comma-separated redirect URIs (required for authorization_code)")
	grants := fs.String("grant-types", "authorization_code", "comma-separated: authorization_code, refresh_token, client_credentials")
	public := fs.Bool("public", false, "public client (no secret, PKCE required), e.g. a CLI")
	native := fs.Bool("native", false, "native application (loopback redirect URIs)")
	method := fs.String("auth-method", "", "client_secret_basic (default) or client_secret_post")
	cfg, _, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-identity")
	if err != nil {
		return err
	}
	defer pool.Close()
	c, err := oidcprovider.RegisterClient(ctx, identitydb.New(pool), oidcprovider.NewClient{
		Name: *name, Public: *public, Native: *native, AuthMethod: *method,
		RedirectURIs: splitComma(*redirects), GrantTypes: splitComma(*grants),
	})
	if err != nil {
		return fmt.Errorf("create-client: %w", err)
	}
	return json.NewEncoder(stdout).Encode(c) //nolint:gosec // G117: printing the new secret once is the point
}

// runRotateKey retires the active signing key and activates a new one. The
// retired key stays in JWKS for identity.refresh_token_ttl; running identity
// replicas switch to the new key within keys.DefaultRefreshInterval.
func runRotateKey(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens identity rotate-key", flag.ContinueOnError)
	fs.SetOutput(stderr)
	cfg, logger, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-identity")
	if err != nil {
		return err
	}
	defer pool.Close()
	signingKeys, err := newKeyManager(pool, cfg, logger)
	if err != nil {
		return err
	}
	active, retired, err := signingKeys.Rotate(ctx)
	if err != nil {
		return fmt.Errorf("rotate-key: %w", err)
	}
	return json.NewEncoder(stdout).Encode(struct {
		KID        string `json:"kid"`
		RetiredKID string `json:"retired_kid,omitempty"`
	}{active.KID, retired})
}

// runAuthz runs the `apilens authz <command>` operator commands.
func runAuthz(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	sub := ""
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "reconcile":
		return runReconcile(ctx, args, stdout, stderr, environ)
	default:
		return fmt.Errorf("authz: unknown command %q (want reconcile)", sub)
	}
}

// runReconcile runs the authz reconciler once (the job the identity role
// runs hourly) and prints how much drift it found.
func runReconcile(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens authz reconcile", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dryRun := fs.Bool("dry-run", false, "report drift without repairing it")
	cfg, logger, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	if !cfg.Authz.Enabled() {
		return errors.New("authz reconcile: authz.endpoint is not set")
	}
	pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-authz")
	if err != nil {
		return err
	}
	defer pool.Close()
	client, err := spicedb.Connect(cfg.Authz)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	// Record ZedTokens like the job does, so checks see the repair at once.
	var tokens authzclient.TokenStore
	if cfg.Valkey.Enabled() {
		vk, err := cache.Connect(ctx, cfg.Valkey)
		if err != nil {
			return err
		}
		defer vk.Close()
		tokens = authzclient.NewValkeyTokens(vk)
	}
	recorder := authzclient.New(client, tokens, authzclient.Options{}, logger, nil)
	res, err := outbox.NewReconciler(pool, client, recorder, outbox.ReconcileOptions{}, logger, nil).Reconcile(ctx, *dryRun)
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(res)
}

func runHealthcheck(ctx context.Context, args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("apilens healthcheck", flag.ContinueOnError)
	fs.SetOutput(stderr)
	url := fs.String("url", "http://127.0.0.1:8080/readyz", "URL that must answer 200")
	timeout := fs.Duration("timeout", 3*time.Second, "request timeout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, *url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %d", *url, resp.StatusCode)
	}
	return nil
}

// runOpenAPI prints the spec of the typed API without starting anything.
func runOpenAPI(stdout io.Writer) error {
	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	server.RegisterMeta(srv.API(), nil)
	query.Register(srv.API(), nil) // handlers are never invoked; only the schema is read
	identity.Register(srv.API())
	identity.RegisterProviders(srv.API(), config.IdentityConfig{})
	identity.NewOAuth(config.IdentityConfig{}, identity.NewValkeyOAuthStateStore(nil), nil, nil).Register(srv.API())
	identity.NewHandoff(config.IdentityConfig{}, nil, nil, nil).Register(srv.API())
	identity.NewSessions(config.IdentityConfig{}, nil, nil, nil).Register(srv.API())
	identity.NewAccount(nil, nil).Register(srv.API())
	identity.NewEmailStart(config.IdentityConfig{}, identity.EmailStartDeps{}, nil, nil).Register(srv.API())
	identity.NewSSOLookup(config.IdentityConfig{}, nil, nil, nil).Register(srv.API())
	identity.NewTwoFactor(nil, nil).Register(srv.API())
	identity.NewEmailChange(nil, nil).Register(srv.API())
	identity.NewEmailVerify(config.IdentityConfig{}, identity.EmailVerifyDeps{}, nil, nil).Register(srv.API())
	identity.NewPasskeys(identity.PasskeysDeps{}, nil).Register(srv.API())
	identity.NewPasskeyLogin(config.IdentityConfig{}, identity.PasskeyLoginDeps{}, nil, nil).Register(srv.API())
	identity.NewRestore(config.IdentityConfig{}, nil, nil, nil, nil).Register(srv.API())
	controlplaneapi.Register(srv.API(), controlplaneapi.Deps{})
	identity.NewRecovery(config.IdentityConfig{}, nil, nil, nil, nil).Register(srv.API())
	identity.NewOIDCRequests(nil, nil).Register(srv.API())
	b, err := json.MarshalIndent(srv.API().OpenAPI(), "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(b))
	return err
}

func splitComma(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
