//go:build integration

package alerts_test

import (
	"context"
	"errors"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEvaluate seeds one window of requests in real ClickHouse and Postgres
// and checks every metric of the catalogue, the filters, the job's state
// writes and the per-rule evaluation latency.
//
// The window is the 5 minutes before the minute of now. In it, the app's
// production environment gets 20 requests, i = 1..20:
//
//	latency    10·i ms (10 .. 200)
//	endpoint   GET /a for odd i, POST /b for even i
//	status     404 for i = 3, 7; 500 for i = 10, 20; else 200
//	consumer   alice for i%4 = 1, bob for 2, carol for 3, none for 0
//
// Requests outside the window, in another environment or of another app
// are noise that no metric may count.
func TestEvaluate(t *testing.T) {
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
	q := db.New(pool)

	// Two and a half minutes into the previous hour, so the */5 cron rule
	// below has its next tick at :05.
	now := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour + 150*time.Second)
	window := alerts.WindowAt(now, 300)
	var rows []pipeline.RequestRow
	row := func(app uuid.UUID, env string, ts time.Time, i int) pipeline.RequestRow {
		method, path := "GET", "/a"
		if i%2 == 0 {
			method, path = "POST", "/b"
		}
		status := uint16(200)
		switch i {
		case 3, 7:
			status = 404
		case 10, 20:
			status = 500
		}
		consumer := []string{"", "alice", "bob", "carol"}[i%4]
		return pipeline.RequestRow{
			ProjectID: seed.ProjectID, AppID: app, Environment: env, Timestamp: ts,
			Method: method, Path: path, RawPath: path, StatusCode: status,
			ResponseTimeMs: float64(10 * i), ConsumerID: consumer, Sampled: true,
		}
	}
	for i := 1; i <= 20; i++ {
		ts := window.Start.Add(time.Duration(i) * 14 * time.Second) // spread over the 5 minutes
		rows = append(rows, row(seed.AppID, "production", ts, i))
		rows = append(rows, row(seed.AppID, "staging", ts, i))
		rows = append(rows, row(other, "production", ts, i))
	}
	for _, ts := range []time.Time{window.Start.Add(-time.Second), window.End, now} {
		r := row(seed.AppID, "production", ts, 10)
		r.ResponseTimeMs = 100000
		r.ConsumerID = "mallory"
		rows = append(rows, r)
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	// Apdex thresholds: 100 ms app-wide, 1000 ms for POST /b.
	if _, err := pool.Exec(ctx, `UPDATE apps SET latency_threshold_ms = 100 WHERE id = $1`, seed.AppID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_settings (app_id, method, path, latency_threshold_ms) VALUES ($1, 'POST', '/b', 1000)`, seed.AppID); err != nil {
		t.Fatal(err)
	}
	// A consumer group of alice and bob, and an empty one.
	pair, empty := uuid.New(), uuid.New()
	for _, g := range []struct {
		id   uuid.UUID
		name string
	}{{pair, "partners"}, {empty, "nobody"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO consumer_groups (id, project_id, name) VALUES ($1, $2, $3)`, g.id, seed.ProjectID, g.name); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []string{"alice", "bob"} {
		if _, err := pool.Exec(ctx, `INSERT INTO consumer_group_members (project_id, consumer_id, group_id) VALUES ($1, $2, $3)`, seed.ProjectID, c, pair); err != nil {
			t.Fatal(err)
		}
	}

	ev := alerts.NewEvaluator(conn, pool, logger, prometheus.NewRegistry())
	rule := func(m alerts.Metric, f alerts.Filters) alerts.Rule {
		return alerts.Rule{
			ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production",
			Metric: m, Condition: alerts.ConditionGT, Threshold: 0, WindowS: 300, Filters: f,
		}
	}

	// Each metric over the seeded window. Percentiles come from t-digests,
	// so they are checked within a tolerance.
	type want struct {
		value, tol float64
		requests   uint64
	}
	cases := []struct {
		name   string
		metric alerts.Metric
		f      alerts.Filters
		want   want
	}{
		{"traffic", alerts.MetricTraffic, alerts.Filters{}, want{20, 0, 20}},
		{"errors", alerts.MetricErrors, alerts.Filters{}, want{4, 0, 20}},
		{"error rate", alerts.MetricErrorRate, alerts.Filters{}, want{0.2, 1e-9, 20}},
		{"p50", alerts.MetricP50, alerts.Filters{}, want{105, 10, 20}},
		{"p75", alerts.MetricP75, alerts.Filters{}, want{155, 10, 20}},
		{"p95", alerts.MetricP95, alerts.Filters{}, want{195, 10, 20}},
		// GET /a: 10..190 at T=100 → 5 satisfied, 5 tolerating; POST /b at
		// T=1000 → 10 satisfied. (15 + 5/2) / 20.
		{"apdex", alerts.MetricApdex, alerts.Filters{}, want{0.875, 1e-9, 20}},
		{"unique consumers", alerts.MetricUniqueConsumers, alerts.Filters{}, want{3, 0, 20}},

		{"traffic of GET /a", alerts.MetricTraffic, alerts.Filters{Endpoint: "GET /a"}, want{10, 0, 10}},
		{"error rate of GET /a", alerts.MetricErrorRate, alerts.Filters{Endpoint: "GET /a"}, want{0.2, 1e-9, 10}},
		{"traffic of /b, any method", alerts.MetricTraffic, alerts.Filters{Endpoint: "/b"}, want{10, 0, 10}},
		{"apdex of GET /a", alerts.MetricApdex, alerts.Filters{Endpoint: "GET /a"}, want{0.75, 1e-9, 10}},
		{"traffic of alice", alerts.MetricTraffic, alerts.Filters{Consumer: "alice"}, want{5, 0, 5}},
		{"p50 of alice", alerts.MetricP50, alerts.Filters{Consumer: "alice"}, want{90, 10, 5}},
		{"traffic of a group", alerts.MetricTraffic, alerts.Filters{Group: pair.String()}, want{10, 0, 10}},
		{"errors of a group", alerts.MetricErrors, alerts.Filters{Group: pair.String()}, want{1, 0, 10}},
		{"unique consumers of a group", alerts.MetricUniqueConsumers, alerts.Filters{Group: pair.String()}, want{2, 0, 10}},
		{"traffic of an empty group", alerts.MetricTraffic, alerts.Filters{Group: empty.String()}, want{0, 0, 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := ev.Evaluate(ctx, rule(c.metric, c.f), now)
			if err != nil {
				t.Fatal(err)
			}
			if res.Window != window {
				t.Errorf("window = %v, want %v", res.Window, window)
			}
			if res.Requests != c.want.requests {
				t.Errorf("requests = %d, want %d", res.Requests, c.want.requests)
			}
			if res.Value == nil || math.Abs(*res.Value-c.want.value) > c.want.tol {
				t.Fatalf("value = %v, want %v ± %v", deref(res.Value), c.want.value, c.want.tol)
			}
			if res.Breached != (*res.Value > 0) {
				t.Errorf("breached = %v for value %v > 0", res.Breached, *res.Value)
			}
		})
	}

	t.Run("no data", func(t *testing.T) {
		for _, m := range alerts.Metrics {
			r := rule(m, alerts.Filters{})
			r.Environment = "development"
			r.Condition, r.Threshold = alerts.ConditionGTE, 0
			res, err := ev.Evaluate(ctx, r, now)
			if err != nil {
				t.Fatal(err)
			}
			count := m == alerts.MetricTraffic || m == alerts.MetricErrors || m == alerts.MetricUniqueConsumers
			switch {
			case count && (res.Value == nil || *res.Value != 0 || !res.Breached):
				t.Errorf("%s: value %v breached %v, want 0 and breached (>= 0)", m, deref(res.Value), res.Breached)
			case !count && (res.Value != nil || res.Breached):
				t.Errorf("%s: value %v breached %v, want no data, not breached", m, deref(res.Value), res.Breached)
			}
		}
	})

	t.Run("invalid group", func(t *testing.T) {
		if _, err := ev.Evaluate(ctx, rule(alerts.MetricTraffic, alerts.Filters{Group: "partners"}), now); !errors.Is(err, alerts.ErrInvalidFilters) {
			t.Errorf("err = %v, want ErrInvalidFilters", err)
		}
	})

	t.Run("job records state of due rules", func(t *testing.T) {
		create := func(name string, m alerts.Metric, cond alerts.Condition, threshold float64, every *int32, cron *string, filters string, enabled bool) uuid.UUID {
			t.Helper()
			r, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
				ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production", Name: name,
				Metric: string(m), Condition: string(cond), Threshold: threshold, WindowS: 300,
				EveryS: every, Cron: cron, Filters: []byte(filters), ChannelIds: []uuid.UUID{}, Enabled: enabled,
			})
			if err != nil {
				t.Fatal(err)
			}
			return r.ID
		}
		minute, fiveMin := int32(60), "*/5 * * * *"
		errRate := create("error rate", alerts.MetricErrorRate, alerts.ConditionGT, 0.1, &minute, nil, `{}`, true)
		p95 := create("p95 of GET /a", alerts.MetricP95, alerts.ConditionGTE, 1000, nil, &fiveMin, `{"endpoint":"GET /a"}`, true)
		off := create("disabled", alerts.MetricTraffic, alerts.ConditionGT, 0, &minute, nil, `{}`, false)

		n, err := ev.RunDue(ctx, now)
		if err != nil || n != 2 {
			t.Fatalf("RunDue = %d, %v; want 2 rules", n, err)
		}
		s, err := q.GetAlertRuleState(ctx, errRate)
		if err != nil {
			t.Fatal(err)
		}
		if !s.EvaluatedAt.Equal(now) || !s.WindowStart.Equal(window.Start) || !s.WindowEnd.Equal(window.End) ||
			s.Value == nil || math.Abs(*s.Value-0.2) > 1e-9 || s.Requests != 20 || !s.Breached {
			t.Errorf("error rate state = %+v (value %v)", s, deref(s.Value))
		}
		s, err = q.GetAlertRuleState(ctx, p95)
		if err != nil {
			t.Fatal(err)
		}
		if s.Value == nil || *s.Value > 1000 || s.Requests != 10 || s.Breached {
			t.Errorf("p95 state = %+v (value %v)", s, deref(s.Value))
		}
		if s.Status != string(alerts.StatusOK) {
			t.Errorf("p95 status = %q, want ok", s.Status)
		}
		// The breached rule has no notify delay: it triggered and opened
		// an event at once.
		if s, _ := q.GetAlertRuleState(ctx, errRate); s.Status != string(alerts.StatusTriggered) || !s.StatusSince.Equal(now) {
			t.Errorf("error rate status = %q since %v, want triggered since now", s.Status, s.StatusSince)
		}
		if e, err := q.GetOpenAlertEvent(ctx, errRate); err != nil || math.Abs(e.Value-0.2) > 1e-9 || !e.StartedAt.Equal(now) {
			t.Errorf("error rate event = %+v, %v", e, err)
		}
		if _, err := q.GetAlertRuleState(ctx, off); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("disabled rule state: err = %v, want none", err)
		}

		// Half a minute later nothing is due; a minute later the every-60 s
		// rule is; the */5 rule waits for its next tick.
		if n, err := ev.RunDue(ctx, now.Add(30*time.Second)); err != nil || n != 0 {
			t.Errorf("RunDue +30s = %d, %v; want 0", n, err)
		}
		if n, err := ev.RunDue(ctx, now.Add(time.Minute)); err != nil || n != 1 {
			t.Errorf("RunDue +1m = %d, %v; want 1", n, err)
		}
		next := now.Truncate(time.Hour).Add(5 * time.Minute)
		if n, err := ev.RunDue(ctx, next.Add(time.Second)); err != nil || n != 2 {
			t.Errorf("RunDue at next */5 tick = %d, %v; want 2", n, err)
		}

		// A rule with a broken cron is skipped without failing the run.
		bad := "61 * * * *"
		create("broken cron", alerts.MetricTraffic, alerts.ConditionGT, 0, nil, &bad, `{}`, true)
		if _, err := ev.RunDue(ctx, next.Add(2*time.Minute)); err != nil {
			t.Errorf("RunDue with a broken rule = %v", err)
		}
	})

	t.Run("evaluation p95 under 200 ms per rule", func(t *testing.T) {
		var durations []time.Duration
		for range 10 {
			for _, m := range alerts.Metrics {
				for _, f := range []alerts.Filters{{}, {Endpoint: "GET /a"}, {Group: pair.String()}} {
					r := rule(m, f)
					if _, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
						ID: r.ID, ProjectID: r.ProjectID, AppID: r.AppID, Environment: r.Environment, Name: "perf " + r.ID.String(),
						Metric: string(m), Condition: "gt", WindowS: 300, EveryS: ptr(int32(60)), Filters: []byte(`{}`),
						ChannelIds: []uuid.UUID{}, Enabled: false,
					}); err != nil {
						t.Fatal(err)
					}
					start := time.Now()
					if _, _, err := ev.EvaluateAndRecord(ctx, r, now); err != nil {
						t.Fatal(err)
					}
					durations = append(durations, time.Since(start))
				}
			}
		}
		slices.Sort(durations)
		p95 := durations[len(durations)*95/100]
		t.Logf("evaluation latency over %d rules: p50 %v, p95 %v, max %v",
			len(durations), durations[len(durations)/2], p95, durations[len(durations)-1])
		if p95 >= 200*time.Millisecond {
			t.Errorf("evaluation p95 = %v, want < 200ms", p95)
		}
	})
}

func deref(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func ptr[T any](v T) *T { return &v }
