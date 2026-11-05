package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/piiaudit"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/pg"
)

// patternFlags collects repeated -pattern name=regex flags.
type patternFlags []string

func (p *patternFlags) String() string     { return strings.Join(*p, ",") }
func (p *patternFlags) Set(v string) error { *p = append(*p, v); return nil }

// runPIIAudit scans captured data for value-level PII and prints one row per
// endpoint, field and pattern. It exits non-zero when anything is found, so
// it can gate a rollout phase in CI.
func runPIIAudit(ctx context.Context, args []string, stdout, stderr io.Writer, environ []string) error {
	fs := flag.NewFlagSet("apilens pii-audit", flag.ContinueOnError)
	fs.SetOutput(stderr)
	csvFile := fs.String("csv", "", "scan this CSV export instead of ClickHouse (- for stdin)")
	project := fs.String("project", "", "project id or slug to sample from ClickHouse")
	since := fs.Duration("since", time.Hour, "how far back to sample")
	limit := fs.Int("limit", 10000, "most recent requests to sample")
	format := fs.String("format", "table", "output format: table or json")
	noDefaults := fs.Bool("no-defaults", false, "run only the -pattern / -patterns-file detectors")
	patternsFile := fs.String("patterns-file", "", "file of extra detectors, one name=regex per line")
	var patterns patternFlags
	fs.Var(&patterns, "pattern", "extra detector as name=regex (repeatable)")
	configFile := fs.String("config.file", "", "YAML config file (for -project)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *format != "table" && *format != "json" {
		return fmt.Errorf("pii-audit: unknown -format %q (want table or json)", *format)
	}
	if (*csvFile == "") == (*project == "") {
		return errors.New("pii-audit: give exactly one of -csv or -project")
	}

	var detectors []piiaudit.Detector
	if !*noDefaults {
		detectors = piiaudit.DefaultDetectors()
	}
	if *patternsFile != "" {
		f, err := os.Open(*patternsFile)
		if err != nil {
			return fmt.Errorf("pii-audit: %w", err)
		}
		extra, err := piiaudit.ReadPatterns(f)
		_ = f.Close()
		if err != nil {
			return fmt.Errorf("pii-audit: %s: %w", *patternsFile, err)
		}
		detectors = append(detectors, extra...)
	}
	for _, p := range patterns {
		d, err := piiaudit.ParsePattern(p)
		if err != nil {
			return fmt.Errorf("pii-audit: %w", err)
		}
		detectors = append(detectors, d)
	}
	if len(detectors) == 0 {
		return errors.New("pii-audit: no detectors (-no-defaults without -pattern or -patterns-file)")
	}

	scanner := piiaudit.NewScanner(detectors)
	if *csvFile != "" {
		in := io.Reader(os.Stdin)
		if *csvFile != "-" {
			f, err := os.Open(*csvFile)
			if err != nil {
				return fmt.Errorf("pii-audit: %w", err)
			}
			defer func() { _ = f.Close() }()
			in = f
		}
		if err := piiaudit.ScanCSV(in, scanner); err != nil {
			return fmt.Errorf("pii-audit: %w", err)
		}
	} else {
		// Only a ClickHouse sample needs the server configuration.
		cfg, err := config.Load(*configFile, environ, nil)
		if err != nil {
			return err
		}
		projectID, err := uuid.Parse(*project)
		if err != nil {
			if projectID, err = projectIDBySlug(ctx, cfg.Postgres, *project); err != nil {
				return fmt.Errorf("pii-audit: %w", err)
			}
		}
		conn, err := ch.Connect(ctx, cfg.ClickHouse)
		if err != nil {
			return err
		}
		defer func() { _ = conn.Close() }()
		err = piiaudit.ScanClickHouse(ctx, conn, piiaudit.Sample{ProjectID: projectID, Since: *since, Limit: *limit}, scanner)
		if err != nil {
			return fmt.Errorf("pii-audit: %w", err)
		}
	}

	findings := scanner.Findings()
	write := piiaudit.WriteTable
	if *format == "json" {
		write = piiaudit.WriteJSON
	}
	if err := write(stdout, findings); err != nil {
		return err
	}
	hits := 0
	for _, f := range findings {
		hits += f.Count
	}
	_, _ = fmt.Fprintf(stderr, "pii-audit: scanned %d records, %d hits\n", scanner.Records(), hits)
	if hits > 0 {
		return fmt.Errorf("pii-audit: %d hits in %d endpoint fields", hits, len(findings))
	}
	return nil
}

// projectIDBySlug resolves an active project's slug to its id.
func projectIDBySlug(ctx context.Context, cfg config.PostgresConfig, slug string) (uuid.UUID, error) {
	pool, err := pg.Connect(ctx, cfg, "apilens-pii-audit")
	if err != nil {
		return uuid.Nil, err
	}
	defer pool.Close()
	var id uuid.UUID
	err = pool.QueryRow(ctx, `SELECT id FROM projects WHERE slug = $1 AND deleted_at IS NULL`, slug).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("project %q not found", slug)
	}
	return id, err
}
