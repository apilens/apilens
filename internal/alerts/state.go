package alerts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Status is a rule's trigger/resolve state (alert_rule_state.status):
//
//	ok ──breach──> pending ──held notify_after_s──> triggered
//	triggered ──clear──> resolving ──held resolve_after_s──> ok
//
// pending falls back to ok when the breach clears before notify_after_s,
// and resolving goes back to triggered when the rule breaches again before
// resolve_after_s, so a metric hovering at the threshold neither notifies
// nor resolves on every crossing. A zero delay skips the intermediate state.
type Status string

// The statuses alert_rule_state.status accepts.
const (
	StatusOK        Status = "ok"
	StatusPending   Status = "pending"
	StatusTriggered Status = "triggered"
	StatusResolving Status = "resolving"
)

// Valid reports whether s is a status alert_rule_state accepts.
func (s Status) Valid() bool {
	switch s {
	case StatusOK, StatusPending, StatusTriggered, StatusResolving:
		return true
	}
	return false
}

// State is where a rule stands: its status and when it entered it. While
// pending, Since is when the breach started; while resolving, when the
// clear started.
type State struct {
	Status Status
	Since  time.Time
}

// Action is what a step asks of the rule's alert event.
type Action int

// The actions a step can take.
const (
	// ActionNone leaves the rule's events alone.
	ActionNone Action = iota
	// ActionTrigger opens an event: the rule has breached for
	// notify_after_s and its channels are to be notified.
	ActionTrigger
	// ActionResolve resolves the open event: the rule has been clear for
	// resolve_after_s.
	ActionResolve
)

func (a Action) String() string {
	switch a {
	case ActionTrigger:
		return "trigger"
	case ActionResolve:
		return "resolve"
	}
	return "none"
}

// Delays are a rule's notify_after_s and resolve_after_s.
type Delays struct {
	NotifyAfter  time.Duration
	ResolveAfter time.Duration
}

// Step is the state machine: given a rule's state before an evaluation at
// now and whether that evaluation breached, it returns the next state and
// the action on the rule's event. It is pure, so replaying an evaluation
// from the same state gives the same answer. An unknown status is treated
// as ok.
func Step(prev State, breached bool, now time.Time, d Delays) (State, Action) {
	switch prev.Status {
	case StatusPending:
		if !breached {
			return State{StatusOK, now}, ActionNone
		}
		if now.Sub(prev.Since) >= d.NotifyAfter {
			return State{StatusTriggered, now}, ActionTrigger
		}
		return prev, ActionNone
	case StatusTriggered:
		if breached {
			return prev, ActionNone
		}
		if d.ResolveAfter <= 0 {
			return State{StatusOK, now}, ActionResolve
		}
		return State{StatusResolving, now}, ActionNone
	case StatusResolving:
		if breached {
			return State{StatusTriggered, now}, ActionNone
		}
		if now.Sub(prev.Since) >= d.ResolveAfter {
			return State{StatusOK, now}, ActionResolve
		}
		return prev, ActionNone
	default: // ok
		if !breached {
			if prev.Status == StatusOK {
				return prev, ActionNone
			}
			return State{StatusOK, now}, ActionNone
		}
		if d.NotifyAfter <= 0 {
			return State{StatusTriggered, now}, ActionTrigger
		}
		return State{StatusPending, now}, ActionNone
	}
}

// Transition is the outcome of recording one evaluation.
type Transition struct {
	From, To State
	Action   Action
	// Event is the event the step opened or resolved; nil for ActionNone.
	Event *db.AlertEvent
	// Replayed is true when the rule already had an evaluation at or after
	// this one (a retried or overlapping run): nothing was written and To
	// is the stored state.
	Replayed bool
}

// TxStore is the control-plane subset recording an evaluation uses inside
// its transaction; *db.Queries satisfies it.
type TxStore interface {
	LockAlertRule(ctx context.Context, id uuid.UUID) (uuid.UUID, error)
	GetAlertRuleState(ctx context.Context, ruleID uuid.UUID) (db.AlertRuleState, error)
	UpsertAlertRuleState(ctx context.Context, arg db.UpsertAlertRuleStateParams) error
	GetOpenAlertEvent(ctx context.Context, ruleID uuid.UUID) (db.AlertEvent, error)
	OpenAlertEvent(ctx context.Context, arg db.OpenAlertEventParams) (db.AlertEvent, error)
	ResolveAlertEvent(ctx context.Context, arg db.ResolveAlertEventParams) (db.AlertEvent, error)
}

// errRuleGone is returned when a rule was deleted between listing and
// recording its evaluation.
var errRuleGone = errors.New("alerts: rule deleted")

// recordEvaluation steps r's state with res and writes the new state and
// the event change through s, which must be bound to one transaction.
//
// It is idempotent: the rule row is locked first, and an evaluation at or
// before the stored evaluated_at (a job retry, or two runs racing) changes
// nothing. Since the state and the event are written in the same
// transaction, a run that fails part-way leaves no trace and the retry
// steps from the same state. Triggering reuses an event that is already
// open, so the alert_events_open index is never violated.
func recordEvaluation(ctx context.Context, s TxStore, r Rule, res Result, now time.Time) (Transition, error) {
	if _, err := s.LockAlertRule(ctx, r.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Transition{}, errRuleGone
		}
		return Transition{}, fmt.Errorf("alerts: lock rule: %w", err)
	}
	prev := State{Status: StatusOK, Since: now}
	stored, err := s.GetAlertRuleState(ctx, r.ID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return Transition{}, fmt.Errorf("alerts: read state: %w", err)
	default:
		prev = State{Status: Status(stored.Status), Since: stored.StatusSince}
		if !now.After(stored.EvaluatedAt) {
			return Transition{From: prev, To: prev, Replayed: true}, nil
		}
	}

	next, action := Step(prev, res.Breached, now, r.Delays())
	t := Transition{From: prev, To: next, Action: action}
	switch action {
	case ActionTrigger:
		ev, err := s.GetOpenAlertEvent(ctx, r.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// The incident started when the breach did, before the
			// notify_after_s wait.
			started := now
			if prev.Status == StatusPending {
				started = prev.Since
			}
			ev, err = s.OpenAlertEvent(ctx, db.OpenAlertEventParams{
				ID: uuid.New(), RuleID: r.ID, Value: *res.Value, StartedAt: started,
			})
			if err != nil {
				return Transition{}, fmt.Errorf("alerts: open event: %w", err)
			}
		case err != nil:
			return Transition{}, fmt.Errorf("alerts: open event: %w", err)
		}
		t.Event = &ev
	case ActionResolve:
		ev, err := s.GetOpenAlertEvent(ctx, r.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Nothing open to resolve (deleted by hand): the state still
			// returns to ok.
		case err != nil:
			return Transition{}, fmt.Errorf("alerts: resolve event: %w", err)
		default:
			// The incident ended when the clear began, before the
			// resolve_after_s wait.
			ended := now
			if prev.Status == StatusResolving {
				ended = prev.Since
			}
			ev, err = s.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: ev.ID, EndedAt: ended})
			if err != nil {
				return Transition{}, fmt.Errorf("alerts: resolve event: %w", err)
			}
			t.Event = &ev
		}
	}

	if err := s.UpsertAlertRuleState(ctx, db.UpsertAlertRuleStateParams{
		RuleID: r.ID, EvaluatedAt: now, WindowStart: res.Window.Start, WindowEnd: res.Window.End,
		Value: res.Value, Requests: int64(min(res.Requests, math.MaxInt64)), Breached: res.Breached,
		Status: string(next.Status), StatusSince: next.Since,
	}); err != nil {
		return Transition{}, fmt.Errorf("alerts: record state: %w", err)
	}
	return t, nil
}
