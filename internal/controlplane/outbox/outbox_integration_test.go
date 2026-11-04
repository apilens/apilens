//go:build integration

package outbox_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/testutil"
)

func TestEmitCommitsAndRollsBackWithTheTransaction(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)

	// Listen on a dedicated connection so the relay wake-up can be observed.
	listener, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN outbox"); err != nil {
		t.Fatal(err)
	}
	notified := func() bool {
		wctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		defer cancel()
		_, err := listener.Conn().WaitForNotification(wctx)
		return err == nil
	}

	// Rolled back: no row, no wake-up.
	org := uuid.New()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(ctx, tx, outbox.OrgDeleted, org, outbox.OrgDeletedPayload{OrgID: org}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool); n != 0 {
		t.Fatalf("rolled-back tx left %d outbox rows", n)
	}
	if notified() {
		t.Fatal("rolled-back tx woke the relay")
	}

	// Committed: one row with the documented shape, and a wake-up.
	user := uuid.New()
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(ctx, tx, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "admin"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if !notified() {
		t.Fatal("committed tx did not wake the relay")
	}
	var topic, agg string
	var raw []byte
	var processed *time.Time
	if err := pool.QueryRow(ctx, `SELECT topic, aggregate_id, payload, processed_at FROM outbox`).Scan(&topic, &agg, &raw, &processed); err != nil {
		t.Fatal(err)
	}
	var got outbox.MembershipUpsertedPayload
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if topic != "membership.upserted" || agg != org.String() || processed != nil ||
		got != (outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "admin"}) {
		t.Fatalf("row = %s %s %s processed=%v", topic, agg, raw, processed)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
