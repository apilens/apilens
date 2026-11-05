package alerts

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func TestStep(t *testing.T) {
	t0 := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }
	delays := Delays{NotifyAfter: 120 * time.Second, ResolveAfter: 180 * time.Second}
	none := Delays{}

	cases := []struct {
		name     string
		prev     State
		breached bool
		now      int
		d        Delays
		want     State
		action   Action
	}{
		// ok
		{"ok stays ok while clear", State{StatusOK, at(0)}, false, 60, delays, State{StatusOK, at(0)}, ActionNone},
		{"ok breach waits in pending", State{StatusOK, at(0)}, true, 60, delays, State{StatusPending, at(60)}, ActionNone},
		{"ok breach triggers at once without notify delay", State{StatusOK, at(0)}, true, 60, none, State{StatusTriggered, at(60)}, ActionTrigger},
		{"unknown status is ok", State{Status("bogus"), at(0)}, false, 60, delays, State{StatusOK, at(60)}, ActionNone},
		{"unknown status breach pends", State{Status(""), at(0)}, true, 60, delays, State{StatusPending, at(60)}, ActionNone},

		// pending
		{"pending holds before notify_after", State{StatusPending, at(0)}, true, 60, delays, State{StatusPending, at(0)}, ActionNone},
		{"pending holds just before notify_after", State{StatusPending, at(0)}, true, 119, delays, State{StatusPending, at(0)}, ActionNone},
		{"pending triggers at notify_after", State{StatusPending, at(0)}, true, 120, delays, State{StatusTriggered, at(120)}, ActionTrigger},
		{"pending triggers after notify_after", State{StatusPending, at(0)}, true, 300, delays, State{StatusTriggered, at(300)}, ActionTrigger},
		{"pending clear falls back to ok", State{StatusPending, at(0)}, false, 60, delays, State{StatusOK, at(60)}, ActionNone},
		{"pending clear after notify_after still ok", State{StatusPending, at(0)}, false, 300, delays, State{StatusOK, at(300)}, ActionNone},

		// triggered
		{"triggered stays while breached", State{StatusTriggered, at(0)}, true, 60, delays, State{StatusTriggered, at(0)}, ActionNone},
		{"triggered clear waits in resolving", State{StatusTriggered, at(0)}, false, 60, delays, State{StatusResolving, at(60)}, ActionNone},
		{"triggered clear resolves at once without resolve delay", State{StatusTriggered, at(0)}, false, 60, none, State{StatusOK, at(60)}, ActionResolve},

		// resolving
		{"resolving holds before resolve_after", State{StatusResolving, at(0)}, false, 120, delays, State{StatusResolving, at(0)}, ActionNone},
		{"resolving resolves at resolve_after", State{StatusResolving, at(0)}, false, 180, delays, State{StatusOK, at(180)}, ActionResolve},
		{"resolving breach returns to triggered without notifying", State{StatusResolving, at(0)}, true, 60, delays, State{StatusTriggered, at(60)}, ActionNone},
		{"resolving breach after resolve_after still triggered", State{StatusResolving, at(0)}, true, 600, delays, State{StatusTriggered, at(600)}, ActionNone},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, action := Step(c.prev, c.breached, at(c.now), c.d)
			if got.Status != c.want.Status || !got.Since.Equal(c.want.Since) || action != c.action {
				t.Errorf("Step(%v, breached=%v, +%ds) = %v@%v %v; want %v@%v %v",
					c.prev.Status, c.breached, c.now, got.Status, got.Since.Sub(t0), action,
					c.want.Status, c.want.Since.Sub(t0), c.action)
			}
			// Pure: the same input gives the same answer.
			if again, a := Step(c.prev, c.breached, at(c.now), c.d); again != got || a != action {
				t.Errorf("Step is not deterministic: %v %v then %v %v", got, action, again, a)
			}
		})
	}
}

// TestStepFlapping runs a rule evaluated every minute through a breach that
// flaps near the threshold: neither the flaps before notify_after nor those
// during resolve_after notify or resolve.
func TestStepFlapping(t *testing.T) {
	t0 := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	d := Delays{NotifyAfter: 2 * time.Minute, ResolveAfter: 2 * time.Minute}
	breaches := []bool{
		true, false, true, false, // flapping: never held 2 min
		true, true, true, // held: pending, pending, trigger
		false, true, false, false, // a dip during resolving, then clear
		false, false, // held clear: resolve
	}
	wantStatus := []Status{
		StatusPending, StatusOK, StatusPending, StatusOK,
		StatusPending, StatusPending, StatusTriggered,
		StatusResolving, StatusTriggered, StatusResolving, StatusResolving,
		StatusOK, StatusOK,
	}
	s := State{StatusOK, t0}
	var actions []Action
	for i, b := range breaches {
		var a Action
		s, a = Step(s, b, t0.Add(time.Duration(i+1)*time.Minute), d)
		if s.Status != wantStatus[i] {
			t.Fatalf("minute %d: status %v, want %v", i+1, s.Status, wantStatus[i])
		}
		if a != ActionNone {
			actions = append(actions, a)
		}
	}
	if len(actions) != 2 || actions[0] != ActionTrigger || actions[1] != ActionResolve {
		t.Errorf("actions = %v, want one trigger then one resolve", actions)
	}
}

func TestStatusValid(t *testing.T) {
	// alert_rule_state.status CHECK in 00023_alert_rule_status.sql.
	for _, s := range []Status{StatusOK, StatusPending, StatusTriggered, StatusResolving} {
		if !s.Valid() {
			t.Errorf("%q not valid", s)
		}
	}
	if Status("firing").Valid() {
		t.Error("firing is not a status")
	}
}

func TestRuleDelays(t *testing.T) {
	d := Rule{NotifyAfterS: 90, ResolveAfterS: 300}.Delays()
	if d.NotifyAfter != 90*time.Second || d.ResolveAfter != 5*time.Minute {
		t.Errorf("Delays = %+v", d)
	}
}

// fakeTx is an in-memory TxStore. It does not roll back; the integration
// test covers transactions.
type fakeTx struct {
	state  *db.AlertRuleState
	events []db.AlertEvent
	gone   bool
	failAt string
}

func (f *fakeTx) LockAlertRule(_ context.Context, id uuid.UUID) (uuid.UUID, error) {
	if f.gone {
		return uuid.Nil, pgx.ErrNoRows
	}
	return id, nil
}

func (f *fakeTx) GetAlertRuleState(context.Context, uuid.UUID) (db.AlertRuleState, error) {
	if f.state == nil {
		return db.AlertRuleState{}, pgx.ErrNoRows
	}
	return *f.state, nil
}

func (f *fakeTx) UpsertAlertRuleState(_ context.Context, a db.UpsertAlertRuleStateParams) error {
	if f.failAt == "upsert" {
		return errors.New("boom")
	}
	f.state = &db.AlertRuleState{
		RuleID: a.RuleID, EvaluatedAt: a.EvaluatedAt, WindowStart: a.WindowStart, WindowEnd: a.WindowEnd,
		Value: a.Value, Requests: a.Requests, Breached: a.Breached, Status: a.Status, StatusSince: a.StatusSince,
	}
	return nil
}

func (f *fakeTx) GetOpenAlertEvent(_ context.Context, rule uuid.UUID) (db.AlertEvent, error) {
	for _, e := range f.events {
		if e.RuleID != nil && *e.RuleID == rule && e.State == "triggered" {
			return e, nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func (f *fakeTx) OpenAlertEvent(_ context.Context, a db.OpenAlertEventParams) (db.AlertEvent, error) {
	e := db.AlertEvent{ID: a.ID, RuleID: &a.RuleID, Kind: "threshold", State: "triggered", Value: a.Value, StartedAt: a.StartedAt}
	f.events = append(f.events, e)
	return e, nil
}

func (f *fakeTx) ResolveAlertEvent(_ context.Context, a db.ResolveAlertEventParams) (db.AlertEvent, error) {
	for i, e := range f.events {
		if e.ID == a.ID && e.State == "triggered" {
			f.events[i].State, f.events[i].EndedAt = "resolved", &a.EndedAt
			return f.events[i], nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func TestRecordEvaluation(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	rule := Rule{ID: uuid.New(), NotifyAfterS: 60, ResolveAfterS: 60}
	breach := func(v float64, at time.Time) Result {
		return Result{Window: WindowAt(at, 300), Value: &v, Requests: 10, Breached: v > 1}
	}
	f := &fakeTx{}

	steps := []struct {
		at     time.Duration
		value  float64
		status Status
		action Action
	}{
		{1 * time.Minute, 5, StatusPending, ActionNone},
		{2 * time.Minute, 6, StatusTriggered, ActionTrigger},
		{3 * time.Minute, 7, StatusTriggered, ActionNone},
		{4 * time.Minute, 0, StatusResolving, ActionNone},
		{5 * time.Minute, 0, StatusOK, ActionResolve},
	}
	for _, s := range steps {
		now := t0.Add(s.at)
		tr, err := recordEvaluation(ctx, f, rule, breach(s.value, now), now)
		if err != nil {
			t.Fatal(err)
		}
		if tr.To.Status != s.status || tr.Action != s.action || tr.Replayed {
			t.Fatalf("+%v: %+v; want %v %v", s.at, tr, s.status, s.action)
		}
		if Status(f.state.Status) != s.status || !f.state.EvaluatedAt.Equal(now) {
			t.Fatalf("+%v: stored %+v", s.at, f.state)
		}
		// A retry of the same evaluation (or an older one) changes nothing.
		before, events := *f.state, len(f.events)
		for _, retry := range []time.Time{now, now.Add(-time.Second)} {
			tr, err := recordEvaluation(ctx, f, rule, breach(s.value, retry), retry)
			if err != nil || !tr.Replayed || tr.Action != ActionNone || tr.To.Status != s.status {
				t.Fatalf("+%v retry: %+v, %v", s.at, tr, err)
			}
		}
		if *f.state != before || len(f.events) != events {
			t.Fatalf("+%v: retry changed state or events", s.at)
		}
	}
	if len(f.events) != 1 {
		t.Fatalf("events = %d, want 1", len(f.events))
	}
	e := f.events[0]
	// Started when the breach did (pending at +1m) and ended when the
	// clear did (resolving at +4m).
	if e.State != "resolved" || !e.StartedAt.Equal(t0.Add(time.Minute)) || e.EndedAt == nil ||
		!e.EndedAt.Equal(t0.Add(4*time.Minute)) || e.Value != 6 {
		t.Errorf("event = %+v", e)
	}

	t.Run("trigger reuses an open event", func(t *testing.T) {
		open := db.AlertEvent{ID: uuid.New(), RuleID: &rule.ID, Kind: "threshold", State: "triggered", Value: 9, StartedAt: t0}
		f := &fakeTx{events: []db.AlertEvent{open}}
		r := rule
		r.NotifyAfterS = 0
		tr, err := recordEvaluation(ctx, f, r, breach(5, t0), t0)
		if err != nil || tr.Action != ActionTrigger || tr.Event == nil || tr.Event.ID != open.ID || len(f.events) != 1 {
			t.Errorf("transition %+v, events %d, err %v", tr, len(f.events), err)
		}
	})

	t.Run("resolve without an open event returns to ok", func(t *testing.T) {
		f := &fakeTx{state: &db.AlertRuleState{RuleID: rule.ID, EvaluatedAt: t0, Status: "triggered", StatusSince: t0}}
		r := rule
		r.ResolveAfterS = 0
		now := t0.Add(time.Minute)
		tr, err := recordEvaluation(ctx, f, r, breach(0, now), now)
		if err != nil || tr.Action != ActionResolve || tr.Event != nil || f.state.Status != "ok" {
			t.Errorf("transition %+v, err %v", tr, err)
		}
	})

	t.Run("deleted rule", func(t *testing.T) {
		if _, err := recordEvaluation(ctx, &fakeTx{gone: true}, rule, breach(5, t0), t0); !errors.Is(err, errRuleGone) {
			t.Errorf("err = %v, want errRuleGone", err)
		}
	})

	t.Run("write failure is an error", func(t *testing.T) {
		if _, err := recordEvaluation(ctx, &fakeTx{failAt: "upsert"}, rule, breach(5, t0), t0); err == nil {
			t.Error("want error")
		}
	})
}
