//go:build integration

package audit_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

// TestRetentionDeletesExpiredEvents runs the retention job against a fake
// clock: events older than audit.retention go, in batches; the rest stay, and
// they go too once the clock moves past their period.
func TestRetentionDeletesExpiredEvents(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	rec := audit.New(pool)

	u, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "retention@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2027, 3, 1, 12, 0, 0, 0, time.UTC)
	// Ages in days relative to now: five past the 400-day period, one exactly
	// at the cutoff (kept: only older events go), and two inside it.
	ages := []int{900, 700, 500, 450, 401, 400, 399, 1}
	for _, age := range ages {
		if err := rec.Record(ctx, audit.Event{User: &u.ID, Kind: audit.LoginSucceeded}); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE audit_events SET created_at = $1 WHERE id = (SELECT max(id) FROM audit_events)`,
			now.AddDate(0, 0, -age)); err != nil {
			t.Fatal(err)
		}
	}
	remaining := func() []time.Time {
		t.Helper()
		evs, err := q.ListAuditEventsForUser(ctx, db.ListAuditEventsForUserParams{UserID: u.ID, PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		out := make([]time.Time, 0, len(evs))
		for _, e := range evs {
			out = append(out, e.CreatedAt.UTC())
		}
		return out
	}

	clock := now
	opts := audit.RetentionOptions{Days: 400, Batch: 2, Now: func() time.Time { return clock }}

	// Keep forever: nothing is deleted.
	forever := audit.NewPruner(pool, audit.RetentionOptions{Days: 0, Batch: 2, Now: opts.Now})
	if n, err := forever.Prune(ctx); err != nil || n != 0 {
		t.Fatalf("keep forever: n=%d err=%v", n, err)
	}
	if got := remaining(); len(got) != len(ages) {
		t.Fatalf("keep forever left %d events, want %d", len(got), len(ages))
	}

	// Through the River worker: the five expired events go in three batches.
	w := audit.NewRetentionWorker(audit.NewPruner(pool, opts), testutil.Logger(t))
	if err := w.Work(ctx, &river.Job[audit.RetentionArgs]{}); err != nil {
		t.Fatal(err)
	}
	got := remaining()
	want := []time.Time{now.AddDate(0, 0, -1), now.AddDate(0, 0, -399), now.AddDate(0, 0, -400)}
	if len(got) != len(want) {
		t.Fatalf("after prune: %v, want %v", got, want)
	}
	for i := range want {
		if !got[i].Equal(want[i]) {
			t.Fatalf("after prune: %v, want %v", got, want)
		}
	}

	// Running again the same day deletes nothing.
	p := audit.NewPruner(pool, opts)
	if n, err := p.Prune(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v", n, err)
	}

	// Two days later the 400- and 399-day-old events have expired too.
	clock = now.AddDate(0, 0, 2)
	if n, err := p.Prune(ctx); err != nil || n != 2 {
		t.Fatalf("two days later: n=%d err=%v, want 2", n, err)
	}
	if got := remaining(); len(got) != 1 || !got[0].Equal(now.AddDate(0, 0, -1)) {
		t.Fatalf("two days later: %v", got)
	}
}
