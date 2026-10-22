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

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/buildinfo"
	"github.com/apilens/apilens/internal/platform/config"
	applog "github.com/apilens/apilens/internal/platform/log"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
)

const usage = `apilens — API observability platform (one binary, many roles)

Usage:
  apilens [-target=all] [-config.file=path]   run roles (comma-separated targets)
  apilens migrate                             apply Postgres and ClickHouse migrations
  apilens seed [flags]                        create a dev org/project/app and print an ingest key
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
	_, _ = fmt.Fprintf(w, usage, strings.Join([]string{TargetAll, TargetEdge, TargetQuery}, ", "), strings.Join(planned, ", "))
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
		return migrate(ctx, cfg, logger)
	}
	logger.Info("apilens starting", "version", buildinfo.Get().Version, "targets", cfg.Target)
	return New(cfg, logger).Run(ctx)
}

func runMigrate(ctx context.Context, args []string, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	cfg, logger, err := loadConfig(fs, args, environ, stderr)
	if err != nil {
		return err
	}
	return migrate(ctx, cfg, logger)
}

func migrate(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	pool, err := pg.Connect(ctx, cfg.Postgres, "apilens-migrate")
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := migrations.UpPostgres(ctx, pool, logger); err != nil {
		return err
	}
	return migrations.UpClickHouse(ctx, cfg.ClickHouse, logger)
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
