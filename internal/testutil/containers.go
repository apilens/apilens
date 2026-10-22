//go:build integration

// Package testutil starts real datastores for integration tests
// (`go test -tags=integration`). Images are pinned to the same digests as
// deploy/compose so tests exercise what ships.
package testutil

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcclickhouse "github.com/testcontainers/testcontainers-go/modules/clickhouse"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcvalkey "github.com/testcontainers/testcontainers-go/modules/valkey"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/pg"
)

const (
	PostgresImage   = "postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27"
	ClickHouseImage = "clickhouse/clickhouse-server:26.8.33.10@sha256:1c0b76ac42e16b4eeb0be84013c67269b660701971d29bab9ad0d01b0ba6c10d"
	ValkeyImage     = "valkey/valkey:9.1.2@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd"
)

// Logger discards output unless the test runs with -v.
func Logger(t *testing.T) *slog.Logger {
	t.Helper()
	if testing.Verbose() {
		return slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// Postgres starts Postgres and returns its config.
func Postgres(t *testing.T) config.PostgresConfig {
	t.Helper()
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, PostgresImage,
		tcpostgres.WithDatabase("apilens"), tcpostgres.WithUsername("apilens"), tcpostgres.WithPassword("apilens"),
		tcpostgres.BasicWaitStrategies())
	testcontainers.CleanupContainer(t, c)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	url, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	return config.PostgresConfig{URL: url, MaxConns: 10}
}

// MigratedPostgres starts Postgres, applies migrations and returns a pool.
func MigratedPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := pg.Connect(ctx, Postgres(t), "apilens-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := migrations.UpPostgres(ctx, pool, Logger(t)); err != nil {
		t.Fatal(err)
	}
	return pool
}

// ClickHouse starts ClickHouse and returns its config (native protocol).
func ClickHouse(t *testing.T) config.ClickHouseConfig {
	t.Helper()
	ctx := context.Background()
	c, err := tcclickhouse.Run(ctx, ClickHouseImage,
		tcclickhouse.WithUsername("apilens"), tcclickhouse.WithPassword("apilens"), tcclickhouse.WithDatabase("apilens"))
	testcontainers.CleanupContainer(t, c)
	if err != nil {
		t.Fatalf("start clickhouse: %v", err)
	}
	host, err := c.ConnectionHost(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return config.ClickHouseConfig{
		Addr: []string{host}, Database: "apilens", Username: "apilens", Password: "apilens",
		MaxOpenConns: 4, DialTimeout: 10 * time.Second,
	}
}

// Valkey starts Valkey and returns its config.
func Valkey(t *testing.T) config.ValkeyConfig {
	t.Helper()
	ctx := context.Background()
	c, err := tcvalkey.Run(ctx, ValkeyImage)
	testcontainers.CleanupContainer(t, c)
	if err != nil {
		t.Fatalf("start valkey: %v", err)
	}
	conn, err := c.ConnectionString(ctx) // redis://host:port
	if err != nil {
		t.Fatal(err)
	}
	addr := strings.TrimPrefix(strings.TrimPrefix(conn, "redis://"), "valkey://")
	return config.ValkeyConfig{Addr: []string{strings.TrimSuffix(addr, "/")}}
}
