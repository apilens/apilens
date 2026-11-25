//go:build integration

package alerts_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEvaluateResources seeds runtime resources in real ClickHouse and
// instance events in Postgres and checks every resource metric, with max
// and avg over instances, the container dedupe and the no-data path.
//
// In the 5-minute window, production has two heartbeats (60 s windows) of:
//
//	c1  container of 4 workers w1..w4: container CPU max 80 avg 60, working
//	    set max 900 avg 600 of 1000, throttled 0.2; each worker reports the
//	    container's one OOM kill; Python GC gen0 600 ms per heartbeat (1 %)
//	c2  container of one instance i5: CPU max 40 avg 20, working set max 500
//	    avg 300 of 1000, throttled 0.6, one OOM kill per heartbeat (2)
//	p1  a process without a container: process CPU max 95 avg 50, Node.js
//	    event-loop p99 50 then 150 ms, GC pause 3000 then 600 ms (5 %, 1 %)
//
// Rows outside the window, of staging or of another app are noise.
func TestEvaluateResources(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	other := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO apps (id, project_id, slug, name) VALUES ($1, $2, 'backoffice', 'Backoffice')`, other, seed.ProjectID); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Truncate(time.Minute).Add(-time.Hour + 30*time.Second)
	window := alerts.WindowAt(now, 300)
	beats := []time.Time{window.Start.Add(time.Minute), window.Start.Add(3 * time.Minute)}

	var rows []pipeline.ResourceRow
	add := func(app uuid.UUID, env, instance, container string, ts time.Time, m map[string]float64) {
		rows = append(rows, pipeline.ResourceRow{
			ProjectID: seed.ProjectID, AppID: app, Environment: env, InstanceID: instance, ContainerID: container,
			Timestamp: ts, WindowS: 60, Samples: 4, Metrics: m,
		})
	}
	seedEnv := func(app uuid.UUID, env string, ts []time.Time) {
		for i, at := range ts {
			for _, w := range []string{"w1", "w2", "w3", "w4"} {
				oom := 0.0
				if i == 0 {
					oom = 1 // every worker sees the container's one kill
				}
				add(app, env, w, "c1", at, map[string]float64{
					"container.cpu.pct_of_limit.max": 80, "container.cpu.pct_of_limit.avg": 60,
					"process.cpu.pct_of_limit.max": 20, "process.cpu.pct_of_limit.avg": 15,
					"container.memory.working_set.max": 900, "container.memory.working_set.avg": 600,
					"container.memory.limit": 1000, "container.cpu.throttled_ratio": 0.2,
					"container.memory.oom_kill": oom, "python.gc.gen0.pause_ms_sum": 600,
				})
			}
			add(app, env, "i5", "c2", at, map[string]float64{
				"container.cpu.pct_of_limit.max": 40, "container.cpu.pct_of_limit.avg": 20,
				"container.memory.working_set.max": 500, "container.memory.working_set.avg": 300,
				"container.memory.limit": 1000, "container.cpu.throttled_ratio": 0.6,
				"container.memory.oom_kill": 1,
			})
			add(app, env, "p1", "", at, map[string]float64{
				"process.cpu.pct_of_limit.max": 95, "process.cpu.pct_of_limit.avg": 50,
				"node.event_loop_delay_ms.p99": []float64{50, 150}[i],
				"node.gc.pause_ms_sum":         []float64{3000, 600}[i],
			})
		}
	}
	seedEnv(seed.AppID, "production", beats)
	seedEnv(seed.AppID, "staging", beats)
	seedEnv(other, "production", beats)
	// Outside the window: before it, and the minute still being written.
	for _, ts := range []time.Time{window.Start.Add(-time.Second), window.End} {
		add(seed.AppID, "production", "p1", "", ts, map[string]float64{
			"process.cpu.pct_of_limit.max": 100, "process.cpu.pct_of_limit.avg": 100,
			"node.event_loop_delay_ms.p99": 9999, "node.gc.pause_ms_sum": 60000,
		})
		add(seed.AppID, "production", "i5", "c2", ts, map[string]float64{
			"container.memory.working_set.max": 1000, "container.memory.limit": 1000,
			"container.cpu.throttled_ratio": 1, "container.memory.oom_kill": 50,
		})
	}
	// "measured": resource rows that measured none of the metrics but RSS.
	add(seed.AppID, "measured", "m1", "c9", beats[0], map[string]float64{"process.memory.rss.max": 1 << 20})
	if err := pipeline.ClickHouseInserters(conn).Resources(ctx, rows); err != nil {
		t.Fatal(err)
	}

	// Restarts: four workers of one container ended by the same heartbeat
	// (one restart), an oom and a suspected_oom; an oom_kill is not a
	// restart; one before the window and one in staging are noise.
	event := func(env, instance, container, kind string, at time.Time) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO app_instance_events (project_id, app_id, environment, instance_id, container_id, kind, at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`, seed.ProjectID, seed.AppID, env, instance, container, kind, at); err != nil {
			t.Fatal(err)
		}
	}
	for _, w := range []string{"o1", "o2", "o3", "o4"} {
		event("production", w, "c0", "restart", beats[0])
	}
	event("production", "x1", "c2", "oom", beats[1])
	event("production", "x2", "c1", "suspected_oom", beats[1].Add(time.Second))
	event("production", "w1", "c1", "oom_kill", beats[0])
	event("production", "x3", "c0", "restart", window.Start.Add(-time.Second))
	event("staging", "x4", "c0", "restart", beats[0].Add(time.Second))
	// "events-only": a restart inferred without resource rows is still data.
	event("events-only", "x5", "c5", "restart", beats[0])

	ev := alerts.NewEvaluator(conn, pool, logger, prometheus.NewRegistry())
	eval := func(t *testing.T, env string, m alerts.Metric, a alerts.Aggregation) alerts.Result {
		t.Helper()
		res, err := ev.Evaluate(ctx, alerts.Rule{
			ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: env,
			Metric: m, Aggregation: a, Condition: alerts.ConditionGTE, Threshold: 0, WindowS: 300,
			// Filters never apply to resource metrics.
			Filters: alerts.Filters{Endpoint: "GET /a", Consumer: "alice"},
		}, now)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	cases := []struct {
		name  string
		m     alerts.Metric
		a     alerts.Aggregation
		value float64
		rows  uint64
	}{
		// cpu: container series c1, c2 and the process p1 (c1's workers'
		// own process CPU is not read where the container's is).
		{"cpu max", alerts.MetricCPUPctOfLimit, "", 95, 12},
		{"cpu avg", alerts.MetricCPUPctOfLimit, alerts.AggregationAvg, (60 + 20 + 50) / 3.0, 12},
		// memory: c1 counted once, not once per worker (row avg 54).
		{"memory max", alerts.MetricMemoryPctOfLimit, alerts.AggregationMax, 90, 10},
		{"memory avg", alerts.MetricMemoryPctOfLimit, alerts.AggregationAvg, 45, 10},
		{"throttled max", alerts.MetricCPUThrottledRatio, "", 0.6, 10},
		{"throttled avg", alerts.MetricCPUThrottledRatio, alerts.AggregationAvg, 0.4, 10},
		{"event loop max", alerts.MetricEventLoopP99, "", 150, 2},
		{"event loop avg", alerts.MetricEventLoopP99, alerts.AggregationAvg, 100, 2},
		// gc: the worst heartbeat (p1's 5 %); avg of w1..w4 at 1 % and p1
		// at 3600 / 120000 = 3 %.
		{"gc pause max", alerts.MetricGCPausePct, "", 5, 10},
		{"gc pause avg", alerts.MetricGCPausePct, alerts.AggregationAvg, (4*1 + 3) / 5.0, 10},
		// oom: c1's one kill seen by four workers counts once, plus c2's 2.
		{"oom kills", alerts.MetricOOMKills, "", 3, 10},
		{"restarts", alerts.MetricRestarts, "", 3, 12},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := eval(t, "production", c.m, c.a)
			if res.Value == nil || math.Abs(*res.Value-c.value) > 1e-9 {
				t.Errorf("value = %v, want %v", deref(res.Value), c.value)
			}
			if res.Requests != c.rows {
				t.Errorf("rows = %d, want %d", res.Requests, c.rows)
			}
			if !res.Breached {
				t.Error("not breached (>= 0)")
			}
		})
	}

	t.Run("no data without resource rows, never 0", func(t *testing.T) {
		for _, m := range alerts.ResourceMetrics {
			if res := eval(t, "development", m, ""); res.Value != nil || res.Breached || res.Requests != 0 {
				t.Errorf("%s: value %v breached %v rows %d, want no data", m, deref(res.Value), res.Breached, res.Requests)
			}
		}
	})

	t.Run("no data when not measured; restarts 0", func(t *testing.T) {
		for _, m := range alerts.ResourceMetrics {
			res := eval(t, "measured", m, "")
			if m == alerts.MetricRestarts {
				if res.Value == nil || *res.Value != 0 || res.Requests != 1 {
					t.Errorf("restarts: value %v rows %d, want 0 over 1 row", deref(res.Value), res.Requests)
				}
				continue
			}
			if res.Value != nil {
				t.Errorf("%s: value %v, want no data", m, deref(res.Value))
			}
		}
	})

	t.Run("restarts without resource rows", func(t *testing.T) {
		if res := eval(t, "events-only", alerts.MetricRestarts, ""); res.Value == nil || *res.Value != 1 {
			t.Errorf("value = %v, want 1", deref(res.Value))
		}
	})

	t.Run("rules store their aggregation", func(t *testing.T) {
		q := db.New(pool)
		create := func(m alerts.Metric, a *string) db.AlertRule {
			t.Helper()
			r, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
				ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production", Name: "r " + uuid.NewString(),
				Metric: string(m), Condition: "gt", Threshold: 50, WindowS: 300, EveryS: ptr(int32(60)),
				Filters: []byte(`{}`), ChannelIds: []uuid.UUID{}, Enabled: true, Aggregation: a,
			})
			if err != nil {
				t.Fatal(err)
			}
			return r
		}
		if r := create(alerts.MetricCPUPctOfLimit, nil); r.Aggregation != "max" {
			t.Errorf("default aggregation = %q, want max", r.Aggregation)
		}
		avg := create(alerts.MetricMemoryPctOfLimit, ptr("avg"))
		if _, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
			ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production", Name: "bad",
			Metric: "cpu_pct_of_limit", Condition: "gt", WindowS: 300, EveryS: ptr(int32(60)),
			Filters: []byte(`{}`), ChannelIds: []uuid.UUID{}, Aggregation: ptr("p95"),
		}); err == nil {
			t.Error("aggregation p95 accepted")
		}
		rules, err := q.ListAlertRulesToEvaluate(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rules {
			if row.ID != avg.ID {
				continue
			}
			r, err := alerts.RuleFromRow(row)
			if err != nil || r.Aggregation != alerts.AggregationAvg {
				t.Fatalf("RuleFromRow = %+v, %v", r, err)
			}
			res, _, err := ev.EvaluateAndRecord(ctx, r, now)
			if err != nil || res.Value == nil || *res.Value != 45 || res.Breached {
				t.Errorf("memory avg rule = %+v (value %v), %v", res, deref(res.Value), err)
			}
		}
	})
}
