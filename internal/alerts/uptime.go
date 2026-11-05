package alerts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Uptime from SDK heartbeats: every SDK process sends POST /v1/heartbeat
// every HeartbeatInterval, which ingest records in app_instances. The
// alerts.uptime job checks every app environment once a minute and marks it
// down when none of its instances has sent a heartbeat for
// UptimeMissedHeartbeats intervals, opening an uptime alert event; the
// first heartbeat after the gap resolves it. A muted environment
// (uptime_monitors.muted) still records its events but sends no
// notifications.

// HeartbeatInterval is how often the SDKs send a heartbeat.
const HeartbeatInterval = time.Minute

// UptimeMissedHeartbeats is how many heartbeat intervals an environment may
// stay silent before it is down.
const UptimeMissedHeartbeats = 3

// UptimeDownAfter is how long an environment may go without a heartbeat
// before it is down. With a check every UptimeInterval, an environment
// whose SDK stops is reported down within UptimeDownAfter+UptimeInterval
// (four minutes).
const UptimeDownAfter = UptimeMissedHeartbeats * HeartbeatInterval

// UptimeInterval is how often the uptime job runs.
const UptimeInterval = time.Minute

// uptimeLookback bounds the environments checked to those that sent a
// heartbeat in the last week: one silent for longer stays down (and its
// event open) until it reports again.
const uptimeLookback = 7 * 24 * time.Hour

// UptimeStatus is an environment's uptime (uptime_monitors.status).
type UptimeStatus string

// The statuses uptime_monitors.status accepts.
const (
	UptimeUp   UptimeStatus = "up"
	UptimeDown UptimeStatus = "down"
)

// UptimeState is where an environment stands before a check.
type UptimeState struct {
	Status UptimeStatus
	Since  time.Time
	// Checked is false before the environment's first check.
	Checked bool
}

// IsDown reports whether an environment whose latest heartbeat arrived at
// lastSeen is down at now.
func IsDown(lastSeen, now time.Time) bool { return now.Sub(lastSeen) > UptimeDownAfter }

// UptimeStep is the uptime state machine: given an environment's state
// before a check at now and its latest heartbeat, it returns the next state
// and the action on the environment's uptime event. Going down opens an
// event that started at the last heartbeat; coming back resolves it at the
// heartbeat that ended the gap. An environment first checked while already
// down was never seen up, so it is recorded down without an event. An
// unknown status is treated as up.
func UptimeStep(prev UptimeState, lastSeen, now time.Time) (UptimeState, Action) {
	down := IsDown(lastSeen, now)
	if !prev.Checked {
		if down {
			return UptimeState{Status: UptimeDown, Since: lastSeen, Checked: true}, ActionNone
		}
		return UptimeState{Status: UptimeUp, Since: now, Checked: true}, ActionNone
	}
	switch {
	case prev.Status == UptimeDown && !down:
		return UptimeState{Status: UptimeUp, Since: lastSeen, Checked: true}, ActionResolve
	case prev.Status == UptimeDown:
		return prev, ActionNone
	case down:
		return UptimeState{Status: UptimeDown, Since: lastSeen, Checked: true}, ActionTrigger
	case prev.Status != UptimeUp:
		return UptimeState{Status: UptimeUp, Since: now, Checked: true}, ActionNone
	default:
		return prev, ActionNone
	}
}

// UptimeTarget is one app environment the uptime job checks.
type UptimeTarget struct {
	ProjectID   uuid.UUID
	AppID       uuid.UUID
	Environment string
	// LastSeenAt is the environment's latest heartbeat.
	LastSeenAt time.Time
}

// UptimeTransition is the outcome of recording one check.
type UptimeTransition struct {
	From, To UptimeState
	Action   Action
	// Event is the uptime event the check opened or resolved; nil for
	// ActionNone.
	Event *db.AlertEvent
	// Muted is whether the environment's notifications are muted.
	Muted bool
	// Replayed is true when the environment already had a check at or
	// after this one (a retried or overlapping run): nothing was written.
	Replayed bool
}

// UptimeTxStore is the control-plane subset recording a check uses inside
// its transaction; *db.Queries satisfies it.
type UptimeTxStore interface {
	EnsureUptimeMonitor(ctx context.Context, arg db.EnsureUptimeMonitorParams) (db.UptimeMonitor, error)
	UpdateUptimeMonitorStatus(ctx context.Context, arg db.UpdateUptimeMonitorStatusParams) error
	GetOpenUptimeEvent(ctx context.Context, arg db.GetOpenUptimeEventParams) (db.AlertEvent, error)
	OpenUptimeEvent(ctx context.Context, arg db.OpenUptimeEventParams) (db.AlertEvent, error)
	ResolveAlertEvent(ctx context.Context, arg db.ResolveAlertEventParams) (db.AlertEvent, error)
}

// recordUptime steps target's uptime state at now and writes the new state
// and the event change through s, which must be bound to one transaction.
//
// Like recordEvaluation it is idempotent: the monitor row is locked first
// and a check at or before the stored checked_at changes nothing. Going
// down reuses an event that is already open, so alert_events_uptime_open is
// never violated.
func recordUptime(ctx context.Context, s UptimeTxStore, target UptimeTarget, now time.Time) (UptimeTransition, error) {
	m, err := s.EnsureUptimeMonitor(ctx, db.EnsureUptimeMonitorParams{
		AppID: target.AppID, Environment: target.Environment, ProjectID: target.ProjectID,
	})
	if err != nil {
		return UptimeTransition{}, fmt.Errorf("alerts: lock uptime monitor: %w", err)
	}
	prev := UptimeState{Status: UptimeStatus(m.Status), Since: m.StatusSince, Checked: m.CheckedAt != nil}
	if m.CheckedAt != nil && !now.After(*m.CheckedAt) {
		return UptimeTransition{From: prev, To: prev, Muted: m.Muted, Replayed: true}, nil
	}

	next, action := UptimeStep(prev, target.LastSeenAt, now)
	t := UptimeTransition{From: prev, To: next, Action: action, Muted: m.Muted}
	scope := db.GetOpenUptimeEventParams{AppID: target.AppID, Environment: target.Environment}
	switch action {
	case ActionTrigger:
		ev, err := s.GetOpenUptimeEvent(ctx, scope)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			ev, err = s.OpenUptimeEvent(ctx, db.OpenUptimeEventParams{
				ID: uuid.New(), AppID: target.AppID, Environment: target.Environment,
				Value: now.Sub(target.LastSeenAt).Seconds(), StartedAt: target.LastSeenAt,
			})
			if err != nil {
				return UptimeTransition{}, fmt.Errorf("alerts: open uptime event: %w", err)
			}
		case err != nil:
			return UptimeTransition{}, fmt.Errorf("alerts: open uptime event: %w", err)
		}
		t.Event = &ev
	case ActionResolve:
		ev, err := s.GetOpenUptimeEvent(ctx, scope)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Nothing open to resolve (deleted by hand): the state still
			// returns to up.
		case err != nil:
			return UptimeTransition{}, fmt.Errorf("alerts: resolve uptime event: %w", err)
		default:
			ev, err = s.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: ev.ID, EndedAt: target.LastSeenAt})
			if err != nil {
				return UptimeTransition{}, fmt.Errorf("alerts: resolve uptime event: %w", err)
			}
			t.Event = &ev
		}
	}

	if err := s.UpdateUptimeMonitorStatus(ctx, db.UpdateUptimeMonitorStatusParams{
		AppID: target.AppID, Environment: target.Environment,
		Status: string(next.Status), StatusSince: next.Since, CheckedAt: now,
	}); err != nil {
		return UptimeTransition{}, fmt.Errorf("alerts: record uptime: %w", err)
	}
	return t, nil
}

// UptimeStore is the control-plane subset the uptime checker reads outside
// a transaction; *db.Queries satisfies it.
type UptimeStore interface {
	ListUptimeTargets(ctx context.Context, since time.Time) ([]db.ListUptimeTargetsRow, error)
}

// UptimeChecker detects heartbeat gaps and records them as uptime events.
type UptimeChecker struct {
	pool   Pool
	store  UptimeStore
	logger *slog.Logger
	checks *prometheus.CounterVec
	events *prometheus.CounterVec
	// jobs enqueues the alerts.notify job of each event change of an
	// unmuted environment; nil sends no notifications.
	jobs Enqueuer
}

// NewUptimeChecker returns an UptimeChecker. reg may be nil.
func NewUptimeChecker(pool Pool, logger *slog.Logger, reg prometheus.Registerer) *UptimeChecker {
	c := &UptimeChecker{
		pool: pool, store: db.New(pool), logger: logger,
		checks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_uptime_checks_total",
			Help: "Heartbeat uptime checks of app environments by result (up, down, error).",
		}, []string{"result"}),
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_uptime_events_total",
			Help: "Uptime events opened (trigger) and resolved (resolve), by whether the environment is muted.",
		}, []string{"action", "muted"}),
	}
	if reg != nil {
		reg.MustRegister(c.checks, c.events)
	}
	return c
}

// WithNotifications makes the checker enqueue an alerts.notify job, in the
// transaction that records it, for every uptime event it opens or resolves
// in an environment that is not muted.
func (c *UptimeChecker) WithNotifications(jobs Enqueuer) *UptimeChecker {
	c.jobs = jobs
	return c
}

// Check records one check of target at now.
func (c *UptimeChecker) Check(ctx context.Context, target UptimeTarget, now time.Time) (UptimeTransition, error) {
	var t UptimeTransition
	err := pgx.BeginFunc(ctx, c.pool, func(tx pgx.Tx) error {
		var err error
		t, err = recordUptime(ctx, db.New(tx), target, now)
		if err != nil || t.Event == nil || t.Muted || c.jobs == nil {
			return err
		}
		kind := NotifyTriggered
		if t.Action == ActionResolve {
			kind = NotifyResolved
		}
		if _, err := c.jobs.InsertTx(ctx, tx, NotifyArgs{EventID: t.Event.ID, Notification: kind}, nil); err != nil {
			return fmt.Errorf("alerts: enqueue notification: %w", err)
		}
		return nil
	})
	switch {
	case err != nil:
		c.checks.WithLabelValues("error").Inc()
		return t, err
	case t.To.Status == UptimeDown:
		c.checks.WithLabelValues("down").Inc()
	default:
		c.checks.WithLabelValues("up").Inc()
	}
	if t.Event != nil {
		c.events.WithLabelValues(t.Action.String(), fmt.Sprint(t.Muted)).Inc()
	}
	return t, nil
}

// RunOnce checks every environment that sent a heartbeat in the last week
// and returns how many it checked. An environment whose check fails is
// logged and skipped; it is checked again on the next run. Only failing to
// list the environments is an error.
func (c *UptimeChecker) RunOnce(ctx context.Context, now time.Time) (int, error) {
	rows, err := c.store.ListUptimeTargets(ctx, now.Add(-uptimeLookback))
	if err != nil {
		return 0, fmt.Errorf("alerts: list uptime targets: %w", err)
	}
	checked := 0
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return checked, err
		}
		target := UptimeTarget{ProjectID: r.ProjectID, AppID: r.AppID, Environment: r.Environment, LastSeenAt: r.LastSeenAt}
		t, err := c.Check(ctx, target, now)
		if err != nil {
			if ctx.Err() != nil {
				return checked, ctx.Err()
			}
			c.logger.WarnContext(ctx, "alerts: uptime check failed", "app_id", r.AppID, "environment", r.Environment, "error", err)
			continue
		}
		checked++
		if t.Event != nil {
			c.logger.InfoContext(ctx, "alerts: uptime changed", "app_id", r.AppID, "environment", r.Environment,
				"status", t.To.Status, "event_id", t.Event.ID, "muted", t.Muted)
		}
	}
	return checked, nil
}

// SetUptimeMuted mutes or unmutes the uptime notifications of an app's
// environment. app must belong to project; the caller checks that.
func SetUptimeMuted(ctx context.Context, q interface {
	SetUptimeMonitorMuted(ctx context.Context, arg db.SetUptimeMonitorMutedParams) (db.UptimeMonitor, error)
}, project, app uuid.UUID, environment string, muted bool) (db.UptimeMonitor, error) {
	m, err := q.SetUptimeMonitorMuted(ctx, db.SetUptimeMonitorMutedParams{
		AppID: app, Environment: environment, ProjectID: project, Muted: muted,
	})
	if err != nil {
		return db.UptimeMonitor{}, fmt.Errorf("alerts: set uptime mute: %w", err)
	}
	return m, nil
}

// UptimeArgs is the periodic job that checks heartbeat uptime.
type UptimeArgs struct{}

// Kind is the job kind.
func (UptimeArgs) Kind() string { return "alerts.uptime" }

// UptimeWorker works UptimeArgs.
type UptimeWorker struct {
	river.WorkerDefaults[UptimeArgs]
	checker *UptimeChecker
	logger  *slog.Logger
}

// NewUptimeWorker returns the uptime worker.
func NewUptimeWorker(c *UptimeChecker, logger *slog.Logger) *UptimeWorker {
	return &UptimeWorker{checker: c, logger: logger}
}

// Timeout keeps one run inside its period.
func (*UptimeWorker) Timeout(*river.Job[UptimeArgs]) time.Duration { return UptimeInterval }

// Work checks every environment now.
func (w *UptimeWorker) Work(ctx context.Context, _ *river.Job[UptimeArgs]) error {
	n, err := w.checker.RunOnce(ctx, time.Now())
	if n > 0 {
		w.logger.DebugContext(ctx, "alerts: checked uptime", "environments", n)
	}
	return err
}

var _ river.Worker[UptimeArgs] = (*UptimeWorker)(nil)
