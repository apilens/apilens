// Package ch opens ClickHouse connections over the native protocol.
package ch

import (
	"context"
	"crypto/tls"
	"database/sql"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/apilens/apilens/internal/platform/buildinfo"
	"github.com/apilens/apilens/internal/platform/config"
)

// Options translates config into clickhouse-go options for the given
// database (pass "" to use cfg.Database).
func Options(cfg config.ClickHouseConfig, database string) *clickhouse.Options {
	if database == "" {
		database = cfg.Database
	}
	opts := &clickhouse.Options{
		Addr:         cfg.Addr,
		Auth:         clickhouse.Auth{Database: database, Username: cfg.Username, Password: cfg.Password},
		DialTimeout:  cfg.DialTimeout,
		MaxOpenConns: cfg.MaxOpenConns,
		MaxIdleConns: cfg.MaxOpenConns,
		Compression:  &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
		ClientInfo: clickhouse.ClientInfo{Products: []struct {
			Name    string
			Version string
		}{{Name: "apilens", Version: buildinfo.Get().Version}}},
	}
	if cfg.Secure {
		opts.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return opts
}

// Connect opens a native connection pool and verifies connectivity.
func Connect(ctx context.Context, cfg config.ClickHouseConfig) (driver.Conn, error) {
	conn, err := clickhouse.Open(Options(cfg, ""))
	if err != nil {
		return nil, fmt.Errorf("clickhouse: open: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("clickhouse: ping: %w", err)
	}
	return conn, nil
}

// OpenDB returns a database/sql handle (used by goose for migrations).
func OpenDB(cfg config.ClickHouseConfig, database string) *sql.DB {
	return clickhouse.OpenDB(Options(cfg, database))
}
