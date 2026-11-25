//go:build integration

package pipeline_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

func TestDirectSinkWritesAllTablesAndRollups(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	sink := pipeline.NewDirectSink(config.SinkConfig{
		Ack: "flush", BatchSize: 1000, FlushInterval: 50 * time.Millisecond, QueueSize: 64,
		InsertTimeout: 10 * time.Second, RetryWindow: time.Second,
	}, pipeline.ClickHouseInserters(conn), logger, pipeline.NewMetrics(nil))
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { _ = sink.Run(runCtx); close(done) }()
	defer func() { stop(); <-done }()

	project, app := uuid.New(), uuid.New()
	minute := time.Now().UTC().Truncate(time.Minute)
	var reqs []pipeline.RequestRow
	for i := range 10 {
		code := uint16(200)
		switch {
		case i < 2:
			code = 500
		case i < 5:
			code = 404
		}
		reqs = append(reqs, pipeline.RequestRow{
			ProjectID: project, AppID: app, Environment: "production", Timestamp: minute.Add(time.Duration(i) * time.Second),
			Method: "GET", Path: "/orders/{id}", StatusCode: code, ResponseTimeMs: float64(10 * (i + 1)),
		})
	}
	attrs := map[string]string{"k": "v"}
	steps := []func() error{
		func() error { return sink.SubmitRequests(ctx, reqs) },
		func() error {
			return sink.SubmitLogs(ctx, []pipeline.LogRow{{ProjectID: project, AppID: app, Environment: "production", Timestamp: minute, Level: "ERROR", Message: "boom", Attributes: attrs}})
		},
		func() error {
			return sink.SubmitSpans(ctx, []pipeline.SpanRow{{ProjectID: project, AppID: app, Environment: "production", Timestamp: minute, TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", SpanID: "00f067aa0ba902b7", Kind: "server", Status: "ok", Attributes: attrs}})
		},
		func() error {
			return sink.SubmitDeploys(ctx, []pipeline.DeployRow{{ProjectID: project, Environment: "production", Release: "v2", DeployedAt: minute}})
		},
	}
	for i, step := range steps {
		if err := step(); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}

	count := func(q string) uint64 {
		t.Helper()
		var n uint64
		if err := conn.QueryRow(ctx, q, project).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	if n := count("SELECT count() FROM api_requests WHERE project_id = ?"); n != 10 {
		t.Errorf("api_requests = %d", n)
	}
	for table, want := range map[string]uint64{"api_logs": 1, "api_spans": 1, "api_deploys": 1} {
		if n := count("SELECT count() FROM " + table + " WHERE project_id = ?"); n != want {
			t.Errorf("%s = %d, want %d", table, n, want)
		}
	}

	var requests, clientErrors, serverErrors uint64
	var p50 float64
	err = conn.QueryRow(ctx, `
		SELECT sum(requests), sum(client_errors), sum(server_errors), toFloat64(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(latency)[1])
		FROM api_requests_1m WHERE project_id = ?`, project).Scan(&requests, &clientErrors, &serverErrors, &p50)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 10 || clientErrors != 3 || serverErrors != 2 {
		t.Errorf("1m rollup = %d requests, %d 4xx, %d 5xx", requests, clientErrors, serverErrors)
	}
	if p50 < 40 || p50 > 70 {
		t.Errorf("p50 = %v, want ~55", p50)
	}
	if n := count("SELECT sum(requests) FROM api_requests_1h WHERE project_id = ?"); n != 10 {
		t.Errorf("1h rollup requests = %d", n)
	}
}

func TestSpanStatusMessageEventsLinksRoundTrip(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	project, app := uuid.New(), uuid.New()
	start := time.Date(2026, 10, 22, 11, 0, 0, 0, time.UTC)
	at := start.Add(5*time.Millisecond + 7) // nanosecond precision survives
	rows := []pipeline.SpanRow{
		{
			ProjectID: project, AppID: app, Environment: "production", Timestamp: start, TraceID: "4bf92f3577b34da6a3ce929d0e0e4736",
			SpanID: "00f067aa0ba902b7", Kind: "server", Status: "error", StatusMessage: "ValueError: card declined",
			Events: []pipeline.SpanEventRow{
				{Time: at, Name: "exception", Attributes: map[string]string{"exception.type": "ValueError", "exception.stacktrace": "Traceback ..."}},
				{Time: at.Add(time.Millisecond), Name: "retry"},
			},
			Links: []pipeline.SpanLink{{TraceID: "5bf92f3577b34da6a3ce929d0e0e4736", SpanID: "10f067aa0ba902b7"}},
		},
		// A span from an older SDK: no message, events or links.
		{ProjectID: project, AppID: app, Environment: "production", Timestamp: start, TraceID: "4bf92f3577b34da6a3ce929d0e0e4736", SpanID: "20f067aa0ba902b7"},
	}
	if err := pipeline.ClickHouseInserters(conn).Spans(ctx, rows); err != nil {
		t.Fatal(err)
	}

	var (
		message    string
		times      []time.Time
		names      []string
		attrs      []map[string]string
		linkTraces []string
		linkSpans  []string
	)
	query := `SELECT status_message, events.time, events.name, events.attributes, links.trace_id, links.span_id
		FROM api_spans WHERE project_id = ? AND span_id = ?`
	if err := conn.QueryRow(ctx, query, project, "00f067aa0ba902b7").Scan(&message, &times, &names, &attrs, &linkTraces, &linkSpans); err != nil {
		t.Fatal(err)
	}
	if message != "ValueError: card declined" {
		t.Errorf("status_message = %q", message)
	}
	if len(times) != 2 || !times[0].Equal(at) || names[0] != "exception" || names[1] != "retry" ||
		attrs[0]["exception.type"] != "ValueError" || attrs[0]["exception.stacktrace"] != "Traceback ..." || len(attrs[1]) != 0 {
		t.Errorf("events = %v %v %v", times, names, attrs)
	}
	if len(linkTraces) != 1 || linkTraces[0] != "5bf92f3577b34da6a3ce929d0e0e4736" || linkSpans[0] != "10f067aa0ba902b7" {
		t.Errorf("links = %v %v", linkTraces, linkSpans)
	}

	if err := conn.QueryRow(ctx, query, project, "20f067aa0ba902b7").Scan(&message, &times, &names, &attrs, &linkTraces, &linkSpans); err != nil {
		t.Fatal(err)
	}
	if message != "" || len(times) != 0 || len(names) != 0 || len(attrs) != 0 || len(linkTraces) != 0 {
		t.Errorf("span without events: %q %v %v %v %v", message, times, names, attrs, linkTraces)
	}
}

func TestRequestNewFieldsRoundTrip(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	project, app := uuid.New(), uuid.New()
	row := pipeline.RequestRow{
		ProjectID: project, AppID: app, Environment: "production", Timestamp: time.Now().UTC(), Method: "POST", Path: "/users",
		StatusCode: 422, Sampled: false, Attributes: map[string]string{"tenant.id": "acme"},
		ValidationErrors: []pipeline.ValidationError{{Loc: "body.email", Msg: "field required", Type: "missing"}},
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, []pipeline.RequestRow{row}); err != nil {
		t.Fatal(err)
	}
	var sampled uint8
	var attrs map[string]string
	var verrs string
	if err := conn.QueryRow(ctx, `SELECT sampled, attributes, validation_errors FROM api_requests WHERE project_id = ?`, project).
		Scan(&sampled, &attrs, &verrs); err != nil {
		t.Fatal(err)
	}
	if sampled != 0 || attrs["tenant.id"] != "acme" || verrs != `[{"loc":"body.email","msg":"field required","type":"missing"}]` {
		t.Fatalf("got sampled=%d attributes=%v validation_errors=%s", sampled, attrs, verrs)
	}

	// Rows written without the new columns (older writers) default to sampled.
	old := uuid.New()
	if err := conn.Exec(ctx, `INSERT INTO api_requests (project_id, app_id, environment, timestamp, method, path)
		VALUES (?, ?, 'production', now64(3), 'GET', '/old')`, old, app); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT sampled, validation_errors FROM api_requests WHERE project_id = ?`, old).Scan(&sampled, &verrs); err != nil {
		t.Fatal(err)
	}
	if sampled != 1 || verrs != "" {
		t.Fatalf("defaults: sampled=%d validation_errors=%q", sampled, verrs)
	}
}

// Runtime resources (M7): a metric the SDK could not measure stays absent
// (null), never 0, and the hourly rollup keeps sum/count/min/max per metric.
func TestResourcesRoundTripAndHourlyRollup(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	sink := pipeline.NewDirectSink(config.SinkConfig{
		Ack: "flush", BatchSize: 1000, FlushInterval: 50 * time.Millisecond, QueueSize: 64,
		InsertTimeout: 10 * time.Second, RetryWindow: time.Second,
	}, pipeline.ClickHouseInserters(conn), logger, pipeline.NewMetrics(nil))
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { _ = sink.Run(runCtx); close(done) }()
	defer func() { stop(); <-done }()

	project, app := uuid.New(), uuid.New()
	hour := time.Now().UTC().Truncate(time.Hour)
	row := func(instance string, at time.Time, m map[string]float64) pipeline.ResourceRow {
		return pipeline.ResourceRow{ProjectID: project, AppID: app, Environment: "production", InstanceID: instance,
			Timestamp: at, WindowS: 60, Samples: 4, ContainerID: "c1", Platform: "k8s", LimitSource: "cgroup_v2",
			Metrics: m, Capabilities: []string{"process.cpu"}, Processes: `[{"pid":1,"comm":"gunicorn"}]`}
	}
	rows := []pipeline.ResourceRow{
		row("w1", hour.Add(time.Minute), map[string]float64{"process.cpu.pct_of_limit.avg": 20, "process.cpu.pct_of_limit.max": 40, "container.memory.working_set.max": 100}),
		row("w1", hour.Add(2*time.Minute), map[string]float64{"process.cpu.pct_of_limit.avg": 40, "process.cpu.pct_of_limit.max": 90}),
		row("w2", hour.Add(time.Minute), map[string]float64{"process.cpu.pct_of_limit.avg": 0}), // a measured zero
	}
	if err := sink.SubmitResources(ctx, rows); err != nil {
		t.Fatal(err)
	}

	var pss *float64
	var zero *float64
	var procs string
	err = conn.QueryRow(ctx, `
		SELECT if(mapContains(metrics, 'process.memory.pss.avg'), metrics['process.memory.pss.avg'], NULL),
		       (SELECT if(mapContains(metrics, 'process.cpu.pct_of_limit.avg'), metrics['process.cpu.pct_of_limit.avg'], NULL)
		          FROM app_instance_resources WHERE project_id = ? AND instance_id = 'w2'),
		       processes
		FROM app_instance_resources WHERE project_id = ? AND instance_id = 'w1' ORDER BY ts LIMIT 1`, project, project).Scan(&pss, &zero, &procs)
	if err != nil {
		t.Fatal(err)
	}
	if pss != nil {
		t.Errorf("unmeasured metric read back as %v, want NULL", *pss)
	}
	if zero == nil || *zero != 0 {
		t.Errorf("measured zero read back as %v, want 0", zero)
	}
	if procs != `[{"pid":1,"comm":"gunicorn"}]` {
		t.Errorf("processes = %q", procs)
	}

	var heartbeats uint64
	var avg, maxPct, ws float64
	var wsCount uint64
	err = conn.QueryRow(ctx, `
		SELECT sum(heartbeats),
		       sumMap(metrics_sum)['process.cpu.pct_of_limit.avg'] / sumMap(metrics_count)['process.cpu.pct_of_limit.avg'],
		       maxMap(metrics_max)['process.cpu.pct_of_limit.max'],
		       maxMap(metrics_max)['container.memory.working_set.max'],
		       sumMap(metrics_count)['container.memory.working_set.max']
		FROM app_instance_resources_1h WHERE project_id = ? AND instance_id = 'w1' AND bucket = ?`, project, hour).
		Scan(&heartbeats, &avg, &maxPct, &ws, &wsCount)
	if err != nil {
		t.Fatal(err)
	}
	if heartbeats != 2 || avg != 30 || maxPct != 90 || ws != 100 || wsCount != 1 {
		t.Errorf("1h rollup = heartbeats %d, avg %v, max %v, ws %v (n=%d); want 2, 30, 90, 100 (n=1)", heartbeats, avg, maxPct, ws, wsCount)
	}
}

// M7: requests carry instance_id; the per-instance rollup has one row per
// instance and minute, and requests of older SDKs (no instance) stay out.
func TestRequestsPerInstanceRollup(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	sink := pipeline.NewDirectSink(config.SinkConfig{
		Ack: "flush", BatchSize: 1000, FlushInterval: 50 * time.Millisecond, QueueSize: 64,
		InsertTimeout: 10 * time.Second, RetryWindow: time.Second,
	}, pipeline.ClickHouseInserters(conn), logger, pipeline.NewMetrics(nil))
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { _ = sink.Run(runCtx); close(done) }()
	defer func() { stop(); <-done }()

	project, app := uuid.New(), uuid.New()
	minute := time.Now().UTC().Truncate(time.Minute)
	var reqs []pipeline.RequestRow
	for i, inst := range []string{"w1", "w1", "w1", "w2", ""} {
		code := uint16(200)
		if i == 2 {
			code = 503
		}
		reqs = append(reqs, pipeline.RequestRow{ProjectID: project, AppID: app, Environment: "production",
			Timestamp: minute.Add(time.Duration(i) * time.Second), Method: "GET", Path: "/x", StatusCode: code,
			ResponseTimeMs: float64(10 * (i + 1)), InstanceID: inst})
	}
	if err := sink.SubmitRequests(ctx, reqs); err != nil {
		t.Fatal(err)
	}
	rows, err := conn.Query(ctx, `SELECT instance_id, sum(requests), sum(server_errors), max(latency_max_ms)
		FROM api_requests_instance_1m WHERE project_id = ? GROUP BY instance_id ORDER BY instance_id`, project)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	type agg struct {
		n, errs uint64
		max     float64
	}
	got := map[string]agg{}
	for rows.Next() {
		var inst string
		var a agg
		if err := rows.Scan(&inst, &a.n, &a.errs, &a.max); err != nil {
			t.Fatal(err)
		}
		got[inst] = a
	}
	if len(got) != 2 || got["w1"] != (agg{3, 1, 30}) || got["w2"] != (agg{1, 0, 40}) {
		t.Fatalf("per-instance rollup = %+v", got)
	}
	var stored string
	if err := conn.QueryRow(ctx, `SELECT instance_id FROM api_requests WHERE project_id = ? AND response_time_ms = 10`, project).Scan(&stored); err != nil || stored != "w1" {
		t.Fatalf("api_requests.instance_id = %q, %v", stored, err)
	}
}
