// Package migrations embeds and applies the Postgres and ClickHouse schemas.
//
// Migrations only move forward in production (roll back by deploying the
// previous image; schemas follow expand/contract so the previous release
// keeps working). Down migrations exist for local development only.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
)

//go:embed postgres/*.sql
var postgresFS embed.FS

//go:embed clickhouse/*.sql
var clickhouseFS embed.FS

// PostgresFS returns the embedded Postgres migrations (also sqlc's schema).
func PostgresFS() fs.FS { return mustSub(postgresFS, "postgres") }

// ClickHouseFS returns the embedded ClickHouse migrations.
func ClickHouseFS() fs.FS { return mustSub(clickhouseFS, "clickhouse") }

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return sub
}

// UpPostgres applies pending Postgres migrations using the given pool.
func UpPostgres(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	db := stdlib.OpenDBFromPool(pool)
	defer func() { _ = db.Close() }()
	return up(ctx, goose.DialectPostgres, db, PostgresFS(), "postgres", logger)
}

// UpClickHouse creates the target database if needed, then applies pending
// ClickHouse migrations.
func UpClickHouse(ctx context.Context, cfg config.ClickHouseConfig, logger *slog.Logger) error {
	if err := ensureDatabase(ctx, cfg); err != nil {
		return err
	}
	db := ch.OpenDB(cfg, "")
	defer func() { _ = db.Close() }()
	return up(ctx, goose.DialectClickHouse, db, ClickHouseFS(), "clickhouse", logger)
}

func ensureDatabase(ctx context.Context, cfg config.ClickHouseConfig) error {
	db := ch.OpenDB(cfg, "default")
	defer func() { _ = db.Close() }()
	// Identifier quoting with backticks; the name comes from operator config.
	if _, err := db.ExecContext(ctx, fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s`", cfg.Database)); err != nil {
		return fmt.Errorf("clickhouse: create database %s: %w", cfg.Database, err)
	}
	return nil
}

func up(ctx context.Context, dialect goose.Dialect, db *sql.DB, fsys fs.FS, name string, logger *slog.Logger) error {
	provider, err := goose.NewProvider(dialect, db, fsys)
	if err != nil {
		return fmt.Errorf("migrations: %s provider: %w", name, err)
	}
	results, err := provider.Up(ctx)
	for _, r := range results {
		if r.Error != nil {
			logger.Error("migration failed", "db", name, "version", r.Source.Version, "file", r.Source.Path, "error", r.Error)
			continue
		}
		logger.Info("migration applied", "db", name, "version", r.Source.Version, "file", r.Source.Path, "duration", r.Duration)
	}
	if err != nil {
		return fmt.Errorf("migrations: %s up: %w", name, err)
	}
	current, err := provider.GetDBVersion(ctx)
	if err != nil {
		return fmt.Errorf("migrations: %s version: %w", name, err)
	}
	logger.Info("schema up to date", "db", name, "version", current, "applied_now", len(results))
	return nil
}
