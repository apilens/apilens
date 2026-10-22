//go:build integration

package migrations_test

import (
	"context"
	"slices"
	"testing"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/testutil"
)

func TestMigrationsApplyAndAreIdempotent(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)

	pool := testutil.MigratedPostgres(t)
	if err := migrations.UpPostgres(ctx, pool, logger); err != nil {
		t.Fatalf("second postgres run should be a no-op: %v", err)
	}
	var tables []string
	rows, err := pool.Query(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	for _, want := range []string{"api_keys", "apps", "environments", "organizations", "outbox", "projects"} {
		if !slices.Contains(tables, want) {
			t.Errorf("postgres table %q missing (have %v)", want, tables)
		}
	}

	chCfg := testutil.ClickHouse(t)
	chCfg.Database = "apilens_migrations" // also proves the database is created on demand
	for i := range 2 {
		if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
			t.Fatalf("clickhouse run %d: %v", i+1, err)
		}
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	var names []string
	chRows, err := conn.Query(ctx, "SELECT name FROM system.tables WHERE database = currentDatabase() ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	for chRows.Next() {
		var name string
		if err := chRows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	_ = chRows.Close()
	for _, want := range []string{"api_deploys", "api_logs", "api_requests", "api_requests_1h", "api_requests_1h_mv", "api_requests_1m", "api_requests_1m_mv", "api_spans"} {
		if !slices.Contains(names, want) {
			t.Errorf("clickhouse table %q missing (have %v)", want, names)
		}
	}
}
