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
		InsertTimeout: 10 * time.Second, MaxRetries: 1,
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
