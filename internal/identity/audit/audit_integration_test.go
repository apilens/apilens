//go:build integration

package audit_test

import (
	"context"
	"net/netip"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestRecordInCallerTx(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	rec := audit.New(pool)

	u, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "audit@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	reqCtx := audit.WithRequest(ctx, audit.Request{IP: netip.MustParseAddr("203.0.113.9"), UserAgent: "itest"})

	list := func() []db.AuditEvent {
		t.Helper()
		evs, err := q.ListAuditEventsForUser(ctx, db.ListAuditEventsForUserParams{UserID: u.ID, PageSize: 10})
		if err != nil {
			t.Fatal(err)
		}
		return evs
	}

	// Rolled back with the caller's transaction.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := rec.Record(audit.WithTx(reqCtx, tx), audit.Event{User: &u.ID, Kind: audit.EmailChanged}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if evs := list(); len(evs) != 0 {
		t.Fatalf("rolled-back event persisted: %+v", evs)
	}

	// Committed with it.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		return rec.Record(audit.WithTx(reqCtx, tx), audit.Event{User: &u.ID, Actor: &u.ID, Kind: audit.PasskeyAdded, Meta: map[string]any{"name": "laptop"}})
	}); err != nil {
		t.Fatal(err)
	}
	// And without a transaction.
	if err := rec.Record(reqCtx, audit.Event{User: &u.ID, Kind: audit.LoginSucceeded}); err != nil {
		t.Fatal(err)
	}

	evs := list()
	if len(evs) != 2 || evs[0].Event != "login.succeeded" || evs[1].Event != "passkey.added" {
		t.Fatalf("events: %+v", evs)
	}
	e := evs[1]
	if e.Ip == nil || e.Ip.String() != "203.0.113.9" || e.UserAgent != "itest" || string(e.Metadata) != `{"name": "laptop"}` {
		t.Fatalf("event: %+v ip=%v meta=%s", e, e.Ip, e.Metadata)
	}
}
