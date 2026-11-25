//go:build integration

package migrations_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/pg"
	"github.com/apilens/apilens/internal/testutil"
)

// A branch's lower migration that lands after higher ones (00046 reaching v2
// after M7's 00047-00050) still applies, instead of failing every database
// already past it.
func TestUpAppliesOutOfOrderMigration(t *testing.T) {
	ctx := context.Background()
	pool, err := pg.Connect(ctx, testutil.Postgres(t), "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	db := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { _ = db.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	file := func(table string) *fstest.MapFile {
		return &fstest.MapFile{Data: []byte("-- +goose Up\nCREATE TABLE IF NOT EXISTS " + table + " (id int);\n-- +goose Down\nDROP TABLE IF EXISTS " + table + ";\n")}
	}
	fsys := fstest.MapFS{"00001_a.sql": file("a"), "00003_c.sql": file("c")}
	if err := migrations.UpFS(ctx, goose.DialectPostgres, db, fsys, "postgres", logger); err != nil {
		t.Fatal(err)
	}
	fsys["00002_b.sql"] = file("b")
	if err := migrations.UpFS(ctx, goose.DialectPostgres, db, fsys, "postgres", logger); err != nil {
		t.Fatalf("out-of-order migration refused: %v", err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.b') IS NOT NULL`).Scan(&exists); err != nil || !exists {
		t.Fatalf("table b exists = %v, %v", exists, err)
	}
}
