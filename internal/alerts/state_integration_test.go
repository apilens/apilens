//go:build integration

package alerts

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

// TestRecordEvaluationPostgres steps a rule through trigger and resolve
// against real Postgres and checks that job retries, rolled-back runs and
// concurrent runs never open a second event or step the state twice.
func TestRecordEvaluationPostgres(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	every := int32(60)
	create := func(notify, resolve int32) Rule {
		t.Helper()
		row, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
			ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production",
			Name: "rule " + uuid.NewString(), Metric: string(MetricErrorRate), Condition: string(ConditionGT),
			Threshold: 0.1, WindowS: 300, EveryS: &every, NotifyAfterS: notify, ResolveAfterS: resolve,
			Filters: []byte(`{}`), ChannelIds: []uuid.UUID{}, Enabled: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		return Rule{ID: row.ID, NotifyAfterS: row.NotifyAfterS, ResolveAfterS: row.ResolveAfterS}
	}
	result := func(v float64, at time.Time) Result {
		return Result{Window: WindowAt(at, 300), Value: &v, Requests: 100, Breached: v > 0.1}
	}
	record := func(r Rule, v float64, at time.Time) (Transition, error) {
		var tr Transition
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var err error
			tr, err = recordEvaluation(ctx, db.New(tx), r, result(v, at), at)
			return err
		})
		return tr, err
	}
	events := func(r Rule) []db.AlertEvent {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT id, rule_id, state, value, started_at, ended_at, notified_at FROM alert_events WHERE rule_id = $1 ORDER BY started_at`, r.ID)
		if err != nil {
			t.Fatal(err)
		}
		evs, err := pgx.CollectRows(rows, pgx.RowToStructByPos[db.AlertEvent])
		if err != nil {
			t.Fatal(err)
		}
		return evs
	}
	t0 := time.Now().UTC().Truncate(time.Minute)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }

	t.Run("trigger and resolve with delays, retried every step", func(t *testing.T) {
		r := create(120, 120)
		steps := []struct {
			value  float64
			status Status
			action Action
		}{
			{0.5, StatusPending, ActionNone},
			{0.05, StatusOK, ActionNone}, // flap: no event
			{0.5, StatusPending, ActionNone},
			{0.6, StatusPending, ActionNone},
			{0.7, StatusTriggered, ActionTrigger},
			{0.0, StatusResolving, ActionNone},
			{0.4, StatusTriggered, ActionNone}, // back before resolve_after: same event
			{0.0, StatusResolving, ActionNone},
			{0.0, StatusResolving, ActionNone},
			{0.0, StatusOK, ActionResolve},
		}
		for i, s := range steps {
			now := at(i + 1)
			tr, err := record(r, s.value, now)
			if err != nil {
				t.Fatal(err)
			}
			if tr.To.Status != s.status || tr.Action != s.action {
				t.Fatalf("minute %d: %v %v, want %v %v", i+1, tr.To.Status, tr.Action, s.status, s.action)
			}
			// The job retries the same evaluation: nothing changes.
			before, _ := q.GetAlertRuleState(ctx, r.ID)
			if tr, err := record(r, s.value, now); err != nil || !tr.Replayed {
				t.Fatalf("minute %d retry: %+v, %v", i+1, tr, err)
			}
			after, _ := q.GetAlertRuleState(ctx, r.ID)
			if after.Status != before.Status || !after.StatusSince.Equal(before.StatusSince) || !after.EvaluatedAt.Equal(before.EvaluatedAt) {
				t.Fatalf("minute %d: retry changed state %+v -> %+v", i+1, before, after)
			}
		}
		evs := events(r)
		if len(evs) != 1 {
			t.Fatalf("events = %d, want 1", len(evs))
		}
		// Breach held from minute 3; the clear that resolved began at 8.
		e := evs[0]
		if e.State != "resolved" || !e.StartedAt.Equal(at(3)) || e.EndedAt == nil || !e.EndedAt.Equal(at(8)) || e.Value != 0.7 {
			t.Errorf("event = %+v", e)
		}
	})

	t.Run("rolled-back run leaves no trace", func(t *testing.T) {
		r := create(0, 0)
		boom := errors.New("crash after recording")
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if _, err := recordEvaluation(ctx, db.New(tx), r, result(0.5, at(1)), at(1)); err != nil {
				return err
			}
			return boom
		})
		if !errors.Is(err, boom) {
			t.Fatal(err)
		}
		if _, err := q.GetAlertRuleState(ctx, r.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("state after rollback: %v", err)
		}
		if n := len(events(r)); n != 0 {
			t.Errorf("events after rollback = %d", n)
		}
		// The retry steps from the same state.
		tr, err := record(r, 0.5, at(1))
		if err != nil || tr.Action != ActionTrigger || len(events(r)) != 1 {
			t.Errorf("retry: %+v, %v, %d events", tr, err, len(events(r)))
		}
	})

	t.Run("concurrent runs trigger once", func(t *testing.T) {
		r := create(0, 0)
		var wg sync.WaitGroup
		errs := make([]error, 8)
		actions := make([]Action, 8)
		for i := range errs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var tr Transition
				tr, errs[i] = record(r, 0.5, at(1))
				actions[i] = tr.Action
			}()
		}
		wg.Wait()
		triggers := 0
		for i, err := range errs {
			if err != nil {
				t.Errorf("run %d: %v", i, err)
			}
			if actions[i] == ActionTrigger {
				triggers++
			}
		}
		if triggers != 1 || len(events(r)) != 1 {
			t.Errorf("triggers = %d, events = %d; want 1, 1", triggers, len(events(r)))
		}
	})

	t.Run("deleted rule", func(t *testing.T) {
		r := create(0, 0)
		if _, err := q.DeleteAlertRule(ctx, db.DeleteAlertRuleParams{ProjectID: seed.ProjectID, ID: r.ID}); err != nil {
			t.Fatal(err)
		}
		if _, err := record(r, 0.5, at(1)); !errors.Is(err, errRuleGone) {
			t.Errorf("err = %v, want errRuleGone", err)
		}
	})
}
