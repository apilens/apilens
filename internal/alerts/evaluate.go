package alerts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/robfig/cron/v3"
	"golang.org/x/sync/errgroup"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// EvaluateInterval is how often the evaluation job runs. Each run evaluates
// the rules that are due (see Due).
const EvaluateInterval = time.Minute

// evaluateConcurrency bounds how many rules one run evaluates at once.
const evaluateConcurrency = 8

// dueSlack absorbs the jitter of the job's start time, so a rule evaluated
// every 60 s is not skipped because this run started a moment early.
const dueSlack = 10 * time.Second

// Store is the control-plane subset the evaluator uses; *db.Queries
// satisfies it.
type Store interface {
	ListAlertRulesToEvaluate(ctx context.Context) ([]db.ListAlertRulesToEvaluateRow, error)
	UpsertAlertRuleState(ctx context.Context, arg db.UpsertAlertRuleStateParams) error
	ListConsumerGroupMembers(ctx context.Context, arg db.ListConsumerGroupMembersParams) ([]string, error)
	ListProjectEndpointLatencyThresholds(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectEndpointLatencyThresholdsRow, error)
	ListProjectAppLatencyThresholds(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectAppLatencyThresholdsRow, error)
}

// Rule is the part of an alert rule evaluation reads.
type Rule struct {
	ID          uuid.UUID
	ProjectID   uuid.UUID
	AppID       uuid.UUID
	Environment string
	Metric      Metric
	Condition   Condition
	Threshold   float64
	WindowS     int32
	EveryS      *int32
	Cron        *string
	Filters     Filters
	// LastEvaluatedAt is nil before the first evaluation.
	LastEvaluatedAt *time.Time
}

// RuleFromRow converts a ListAlertRulesToEvaluate row.
func RuleFromRow(r db.ListAlertRulesToEvaluateRow) (Rule, error) {
	f, err := ParseFilters(r.Filters)
	if err != nil {
		return Rule{}, err
	}
	rule := Rule{
		ID: r.ID, ProjectID: r.ProjectID, AppID: r.AppID, Environment: r.Environment,
		Metric: Metric(r.Metric), Condition: Condition(r.Condition), Threshold: r.Threshold,
		WindowS: r.WindowS, EveryS: r.EveryS, Cron: r.Cron, Filters: f, LastEvaluatedAt: r.LastEvaluatedAt,
	}
	if !rule.Metric.Valid() {
		return Rule{}, fmt.Errorf("alerts: unknown metric %q", r.Metric)
	}
	if !rule.Condition.Valid() {
		return Rule{}, fmt.Errorf("alerts: unknown condition %q", r.Condition)
	}
	return rule, nil
}

// cronParser reads alert_rules.cron: five fields (minute hour day-of-month
// month day-of-week) or a descriptor such as @hourly, in UTC.
var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// ParseCron validates a cron schedule as the evaluator reads it.
func ParseCron(spec string) (cron.Schedule, error) {
	s, err := cronParser.Parse(spec)
	if err != nil {
		return nil, fmt.Errorf("alerts: cron %q: %w", spec, err)
	}
	return s, nil
}

// Due reports whether r should be evaluated at now: always before its first
// evaluation; then once every_s has passed since the last one, or, with a
// cron schedule, once a tick of the schedule has passed since the last one.
func (r Rule) Due(now time.Time) (bool, error) {
	if r.LastEvaluatedAt == nil {
		return true, nil
	}
	last := r.LastEvaluatedAt.UTC()
	if r.Cron != nil {
		s, err := ParseCron(*r.Cron)
		if err != nil {
			return false, err
		}
		// Ticks fall on whole minutes and runs start anywhere in a minute:
		// due once the first tick after the minute of the last evaluation
		// has passed, so each tick is evaluated once.
		return !s.Next(last.Truncate(time.Minute)).After(now.UTC()), nil
	}
	every := time.Minute
	if r.EveryS != nil && *r.EveryS > 0 {
		every = time.Duration(*r.EveryS) * time.Second
	}
	return now.Sub(last)+dueSlack >= every, nil
}

// Result is one evaluation of a rule.
type Result struct {
	Window Window
	// Value is nil when the window has no data for the metric (no requests
	// for a rate, percentile or Apdex). Counts are 0 instead.
	Value    *float64
	Requests uint64
	Breached bool
}

// Evaluator evaluates alert rules over ClickHouse and records the results
// in alert_rule_state.
type Evaluator struct {
	ch       driver.Conn
	store    Store
	logger   *slog.Logger
	duration *prometheus.HistogramVec
	runs     *prometheus.CounterVec
}

// NewEvaluator returns an Evaluator. reg may be nil.
func NewEvaluator(conn driver.Conn, store Store, logger *slog.Logger, reg prometheus.Registerer) *Evaluator {
	e := &Evaluator{
		ch: conn, store: store, logger: logger,
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "apilens_alerts_evaluation_duration_seconds",
			Help:    "Time to evaluate one alert rule (ClickHouse query and state write), by metric.",
			Buckets: []float64{.005, .01, .025, .05, .1, .2, .5, 1, 2.5},
		}, []string{"metric"}),
		runs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_alerts_evaluations_total",
			Help: "Alert rule evaluations by result (ok, breached, error).",
		}, []string{"result"}),
	}
	if reg != nil {
		reg.MustRegister(e.duration, e.runs)
	}
	return e
}

// Evaluate computes r's metric over the window ending at now and compares
// it to the threshold. It writes nothing.
func (e *Evaluator) Evaluate(ctx context.Context, r Rule, now time.Time) (Result, error) {
	scope := queryScope{
		project: r.ProjectID, app: r.AppID, environment: r.Environment,
		window: WindowAt(now, r.WindowS), filters: r.Filters,
	}
	if r.Filters.Group != "" {
		group, err := uuid.Parse(r.Filters.Group)
		if err != nil {
			return Result{}, fmt.Errorf("%w: group must be a consumer group id", ErrInvalidFilters)
		}
		members, err := e.store.ListConsumerGroupMembers(ctx, db.ListConsumerGroupMembersParams{ProjectID: r.ProjectID, GroupID: group})
		if err != nil {
			return Result{}, fmt.Errorf("alerts: consumer group members: %w", err)
		}
		scope.members = members
	}
	if r.Metric == MetricApdex {
		t, err := e.apdexThresholds(ctx, r.ProjectID, r.AppID)
		if err != nil {
			return Result{}, err
		}
		scope.apdex = t
	}
	q, err := buildQuery(r.Metric, scope)
	if err != nil {
		return Result{}, err
	}
	var (
		n     uint64
		value float64
	)
	if err := e.ch.QueryRow(ctx, q.sql, q.args...).Scan(&n, &value); err != nil {
		return Result{}, fmt.Errorf("alerts: evaluate %s: %w", r.Metric, err)
	}
	res := Result{Window: scope.window, Requests: n}
	switch {
	case n == 0 && r.Metric.countLike():
		zero := 0.0
		res.Value = &zero
	case n == 0, math.IsNaN(value), math.IsInf(value, 0):
		// No data.
	default:
		res.Value = &value
	}
	res.Breached = r.Condition.Breached(res.Value, r.Threshold)
	return res, nil
}

func (e *Evaluator) apdexThresholds(ctx context.Context, project, app uuid.UUID) (apdexThresholds, error) {
	eps, err := e.store.ListProjectEndpointLatencyThresholds(ctx, project)
	if err != nil {
		return apdexThresholds{}, fmt.Errorf("alerts: apdex thresholds: %w", err)
	}
	apps, err := e.store.ListProjectAppLatencyThresholds(ctx, project)
	if err != nil {
		return apdexThresholds{}, fmt.Errorf("alerts: apdex thresholds: %w", err)
	}
	var t apdexThresholds
	for _, r := range eps {
		if r.AppID == app {
			t.endpoints = append(t.endpoints, endpointThreshold{method: r.Method, path: r.Path, ms: r.LatencyThresholdMs})
		}
	}
	for _, r := range apps {
		if r.ID == app {
			t.app = r.LatencyThresholdMs
		}
	}
	return t, nil
}

// EvaluateAndRecord evaluates r at now and records the result in
// alert_rule_state.
func (e *Evaluator) EvaluateAndRecord(ctx context.Context, r Rule, now time.Time) (Result, error) {
	start := time.Now()
	res, err := e.Evaluate(ctx, r, now)
	if err == nil {
		err = e.store.UpsertAlertRuleState(ctx, db.UpsertAlertRuleStateParams{
			RuleID: r.ID, EvaluatedAt: now, WindowStart: res.Window.Start, WindowEnd: res.Window.End,
			Value: res.Value, Requests: int64(min(res.Requests, math.MaxInt64)), Breached: res.Breached,
		})
		if err != nil {
			err = fmt.Errorf("alerts: record state: %w", err)
		}
	}
	e.duration.WithLabelValues(string(r.Metric)).Observe(time.Since(start).Seconds())
	switch {
	case err != nil:
		e.runs.WithLabelValues("error").Inc()
	case res.Breached:
		e.runs.WithLabelValues("breached").Inc()
	default:
		e.runs.WithLabelValues("ok").Inc()
	}
	return res, err
}

// RunDue evaluates every enabled rule that is due at now and records the
// results; it returns how many rules it evaluated. A rule that fails (a bad
// cron or filter, a query error) is logged and skipped so it cannot hold up
// the others; it is retried on the next run. Only failing to list the rules
// is an error.
func (e *Evaluator) RunDue(ctx context.Context, now time.Time) (int, error) {
	rows, err := e.store.ListAlertRulesToEvaluate(ctx)
	if err != nil {
		return 0, fmt.Errorf("alerts: list rules: %w", err)
	}
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(evaluateConcurrency)
	evaluated := make(chan struct{}, len(rows))
	for _, row := range rows {
		rule, err := RuleFromRow(row)
		if err != nil {
			e.logger.WarnContext(ctx, "alerts: skipping invalid rule", "rule_id", row.ID, "error", err)
			e.runs.WithLabelValues("error").Inc()
			continue
		}
		due, err := rule.Due(now)
		if err != nil {
			e.logger.WarnContext(ctx, "alerts: skipping rule with invalid schedule", "rule_id", rule.ID, "error", err)
			e.runs.WithLabelValues("error").Inc()
			continue
		}
		if !due {
			continue
		}
		g.Go(func() error {
			if _, err := e.EvaluateAndRecord(gctx, rule, now); err != nil {
				if gctx.Err() != nil {
					return gctx.Err()
				}
				e.logger.WarnContext(gctx, "alerts: rule evaluation failed", "rule_id", rule.ID, "metric", rule.Metric, "error", err)
				return nil
			}
			evaluated <- struct{}{}
			return nil
		})
	}
	err = g.Wait()
	close(evaluated)
	if err != nil && errors.Is(err, context.Canceled) && ctx.Err() == nil {
		err = nil
	}
	return len(evaluated), err
}

// EvaluateArgs is the periodic job that evaluates due alert rules.
type EvaluateArgs struct{}

// Kind is the job kind.
func (EvaluateArgs) Kind() string { return "alerts.evaluate" }

// EvaluateWorker works EvaluateArgs.
type EvaluateWorker struct {
	river.WorkerDefaults[EvaluateArgs]
	evaluator *Evaluator
	logger    *slog.Logger
}

// NewEvaluateWorker returns the evaluation worker.
func NewEvaluateWorker(e *Evaluator, logger *slog.Logger) *EvaluateWorker {
	return &EvaluateWorker{evaluator: e, logger: logger}
}

// Timeout keeps one run inside its period.
func (*EvaluateWorker) Timeout(*river.Job[EvaluateArgs]) time.Duration { return EvaluateInterval }

// Work evaluates the rules due now.
func (w *EvaluateWorker) Work(ctx context.Context, _ *river.Job[EvaluateArgs]) error {
	n, err := w.evaluator.RunDue(ctx, time.Now())
	if n > 0 {
		w.logger.DebugContext(ctx, "alerts: evaluated rules", "rules", n)
	}
	return err
}
