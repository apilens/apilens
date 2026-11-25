package alerts

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// defaultApdexThresholdMs is Apdex T when neither the endpoint nor the app
// sets one (the dashboard's default, internal/query).
const defaultApdexThresholdMs = 500

// endpointThreshold is an endpoint's own Apdex threshold.
type endpointThreshold struct {
	method, path string
	ms           int32
}

// apdexThresholds are the Apdex thresholds of one app: its endpoints' own,
// then the app-wide one (0 when unset).
type apdexThresholds struct {
	endpoints []endpointThreshold
	app       int32
}

// expr is the ClickHouse expression of T for a raw api_requests row of the
// app: endpoint thresholds first, then the app's, then the default.
// Thresholds are validated integers, so they are inlined; keys are bound.
func (t apdexThresholds) expr() (string, []any) {
	fallback := int32(defaultApdexThresholdMs)
	if t.app > 0 {
		fallback = t.app
	}
	if len(t.endpoints) == 0 {
		return fmt.Sprintf("%d", fallback), nil
	}
	terms := make([]string, 0, 2*len(t.endpoints)+1)
	args := make([]any, 0, 2*len(t.endpoints))
	for _, e := range t.endpoints {
		terms = append(terms, "method = ? AND path = ?", fmt.Sprintf("%d", e.ms))
		args = append(args, e.method, e.path)
	}
	terms = append(terms, fmt.Sprintf("%d", fallback))
	return "multiIf(" + strings.Join(terms, ", ") + ")", args
}

// quantileIndex is each percentile's position in the rollup's
// quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99) state (1-based).
var quantileIndex = map[Metric]int{MetricP50: 1, MetricP75: 2, MetricP95: 4}

// quantileLevel is each percentile's level for raw rows.
var quantileLevel = map[Metric]string{MetricP50: "0.5", MetricP75: "0.75", MetricP95: "0.95"}

// usesRollup reports whether a rule's value can be read from the
// api_requests_1m rollup. Apdex and unique consumers need raw rows, as does
// any consumer or group filter (the rollup has no consumer columns).
func usesRollup(m Metric, f Filters) bool {
	switch m {
	case MetricApdex, MetricUniqueConsumers:
		return false
	}
	return !f.byConsumer()
}

// evalQuery is one rule's ClickHouse query. It returns one row: the number
// of requests in the window (UInt64) and the metric's value (Float64; NaN
// or meaningless when there are no requests).
type evalQuery struct {
	sql  string
	args []any
}

// queryScope is what a rule's query is bound to besides its metric.
type queryScope struct {
	project, app uuid.UUID
	environment  string
	window       Window
	filters      Filters
	apdex        apdexThresholds
	// aggregation combines a resource gauge over the series; "" is max.
	aggregation Aggregation
}

// buildQuery builds the query of metric m over s.
func buildQuery(m Metric, s queryScope) (evalQuery, error) {
	if !m.Valid() {
		return evalQuery{}, fmt.Errorf("alerts: unknown metric %q", m)
	}
	if m.IsResource() {
		return buildResourceQuery(m, s), nil
	}
	method, path := s.filters.endpoint()
	if usesRollup(m, s.filters) {
		where := []string{"project_id = ?", "app_id = ?", "environment = ?", "bucket >= ?", "bucket < ?"}
		args := []any{s.project, s.app, s.environment, s.window.Start, s.window.End}
		if method != "" {
			where, args = append(where, "method = ?"), append(args, method)
		}
		if path != "" {
			where, args = append(where, "path = ?"), append(args, path)
		}
		var value string
		switch m {
		case MetricTraffic:
			value = "toFloat64(sum(requests))"
		case MetricErrors:
			value = "toFloat64(sum(client_errors) + sum(server_errors))"
		case MetricErrorRate:
			value = "if(sum(requests) = 0, 0, (sum(client_errors) + sum(server_errors)) / sum(requests))"
		case MetricServerErrors:
			value = "toFloat64(sum(server_errors))"
		case MetricServerErrorRate:
			value = "if(sum(requests) = 0, 0, sum(server_errors) / sum(requests))"
		case MetricClientErrors:
			value = "toFloat64(sum(client_errors))"
		case MetricClientErrorRate:
			value = "if(sum(requests) = 0, 0, sum(client_errors) / sum(requests))"
		default:
			value = fmt.Sprintf("toFloat64(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(latency)[%d])", quantileIndex[m])
		}
		return evalQuery{
			sql:  "SELECT toUInt64(sum(requests)), " + value + " FROM api_requests_1m WHERE " + strings.Join(where, " AND "),
			args: args,
		}, nil
	}

	where := []string{"project_id = ?", "app_id = ?", "environment = ?", "timestamp >= ?", "timestamp < ?"}
	args := []any{s.project, s.app, s.environment, s.window.Start, s.window.End}
	if method != "" {
		where, args = append(where, "method = ?"), append(args, method)
	}
	if path != "" {
		where, args = append(where, "path = ?"), append(args, path)
	}
	if s.filters.Consumer != "" {
		where, args = append(where, "consumer_id = ?"), append(args, s.filters.Consumer)
	}
	if s.filters.Group != "" {
		where, args = append(where, "consumer_group = ?"), append(args, s.filters.Group)
	}
	var (
		with   string
		value  string
		prefix []any
	)
	switch m {
	case MetricTraffic:
		value = "toFloat64(count())"
	case MetricErrors:
		value = "toFloat64(countIf(status_code >= 400))"
	case MetricErrorRate:
		value = "if(count() = 0, 0, countIf(status_code >= 400) / count())"
	case MetricServerErrors:
		value = "toFloat64(countIf(status_code >= 500))"
	case MetricServerErrorRate:
		value = "if(count() = 0, 0, countIf(status_code >= 500) / count())"
	case MetricClientErrors:
		value = "toFloat64(countIf(status_code >= 400 AND status_code < 500))"
	case MetricClientErrorRate:
		value = "if(count() = 0, 0, countIf(status_code >= 400 AND status_code < 500) / count())"
	case MetricP50, MetricP75, MetricP95:
		value = fmt.Sprintf("toFloat64(quantileTDigest(%s)(response_time_ms))", quantileLevel[m])
	case MetricApdex:
		expr, targs := s.apdex.expr()
		with, prefix = "WITH "+expr+" AS apdex_t ", targs
		value = "if(count() = 0, 0, (countIf(response_time_ms <= apdex_t) + " +
			"countIf(response_time_ms > apdex_t AND response_time_ms <= 4 * apdex_t) / 2) / count())"
	case MetricUniqueConsumers:
		value = "toFloat64(uniqExactIf(consumer_id, consumer_id != ''))"
	}
	return evalQuery{
		sql:  with + "SELECT count(), " + value + " FROM api_requests WHERE " + strings.Join(where, " AND "),
		args: append(prefix, args...),
	}, nil
}

// The resource keys (app_instance_resources.metrics) the resource metrics
// read. A key that is absent was not measured, never 0.
const (
	keyContainerCPU   = "container.cpu.pct_of_limit"
	keyProcessCPU     = "process.cpu.pct_of_limit"
	keyWorkingSet     = "container.memory.working_set"
	keyMemoryLimit    = "container.memory.limit"
	keyThrottledRatio = "container.cpu.throttled_ratio"
	keyEventLoopP99   = "node.event_loop_delay_ms.p99"
	keyOOMKill        = "container.memory.oom_kill"
)

// gcPauseKeys are the GC pause time sums (ms over the heartbeat window) of
// every runtime; a process reports those of its own runtime.
var gcPauseKeys = []string{
	"jvm.gc.pause_ms_sum", "node.gc.pause_ms_sum",
	"python.gc.gen0.pause_ms_sum", "python.gc.gen1.pause_ms_sum", "python.gc.gen2.pause_ms_sum",
}

// containerSeries keys a row by its container, so the workers of one
// container are one series; a row without a container_id is its own
// instance's series.
const containerSeries = "if(container_id = '', concat('i:', instance_id), concat('c:', container_id))"

// has is the ClickHouse condition that the row measured key.
func has(key string) string { return "mapContains(metrics, '" + key + "')" }

// val is the ClickHouse value of key in a row (0 when absent: guard with has).
func val(key string) string { return "metrics['" + key + "']" }

// buildResourceQuery builds the query of resource metric m over s. It
// returns one row: the number of resource rows that measured the metric
// (UInt64; for restarts, every resource row of the app and environment) and
// the metric's value (Float64; NaN when no row measured it). The value of
// restarts is read from Postgres instead (see Evaluator.Evaluate).
//
// Gauges are aggregated in two steps: per series over the window (the
// rows' max gauge and max() for AggregationMax, their avg gauge and avg()
// for AggregationAvg), then over the series by the same function. Keys are
// constants, so they are inlined; the scope is bound.
func buildResourceQuery(m Metric, s queryScope) evalQuery {
	where := "project_id = ? AND app_id = ? AND environment = ? AND ts >= ? AND ts < ?"
	args := []any{s.project, s.app, s.environment, s.window.Start, s.window.End}
	agg, stat := "max", ".max"
	if s.aggregation == AggregationAvg {
		agg, stat = "avg", ".avg"
	}
	gauge := func(series, value, cond string) evalQuery {
		return evalQuery{
			sql: "SELECT toUInt64(sum(n)), if(sum(n) = 0, nan, toFloat64(" + agg + "(v))) FROM (" +
				"SELECT " + series + " AS series, count() AS n, " + value + " AS v FROM app_instance_resources " +
				"WHERE " + where + " AND " + cond + " GROUP BY series)",
			args: args,
		}
	}
	switch m {
	case MetricCPUPctOfLimit:
		// The container's CPU where reported (one series per container),
		// else the process's (one per instance).
		c, p := keyContainerCPU+stat, keyProcessCPU+stat
		inContainer := "(" + has(c) + " AND container_id != '')"
		return gauge(
			"if("+inContainer+", concat('c:', container_id), concat('i:', instance_id))",
			agg+"(if("+inContainer+", "+val(c)+", "+val(p)+"))",
			"("+inContainer+" OR "+has(p)+")")
	case MetricMemoryPctOfLimit:
		ws := keyWorkingSet + stat
		return gauge(containerSeries,
			agg+"(least(100, "+val(ws)+" / "+val(keyMemoryLimit)+" * 100))",
			has(ws)+" AND "+has(keyMemoryLimit)+" AND "+val(keyMemoryLimit)+" > 0")
	case MetricCPUThrottledRatio:
		return gauge(containerSeries, agg+"("+val(keyThrottledRatio)+")", has(keyThrottledRatio))
	case MetricEventLoopP99:
		return gauge("instance_id", agg+"("+val(keyEventLoopP99)+")", has(keyEventLoopP99))
	case MetricGCPausePct:
		hasAny := make([]string, len(gcPauseKeys))
		sum := make([]string, len(gcPauseKeys))
		for i, k := range gcPauseKeys {
			hasAny[i], sum[i] = has(k), val(k)
		}
		pause := "(" + strings.Join(sum, " + ") + ")"
		// max: the worst heartbeat; avg: the pause time over the time.
		value := "max(least(100, " + pause + " / (window_s * 1000) * 100))"
		if s.aggregation == AggregationAvg {
			value = "least(100, sum(" + pause + ") / sum(window_s * 1000) * 100)"
		}
		return gauge("instance_id", value, "("+strings.Join(hasAny, " OR ")+") AND window_s > 0")
	case MetricOOMKills:
		// Every worker of a container reports the container's OOM kills:
		// per container the kills of the instance that saw the most, then
		// the containers' total.
		return evalQuery{
			sql: "SELECT toUInt64(sum(rows)), toFloat64(sum(v)) FROM (" +
				"SELECT series, sum(n) AS rows, max(k) AS v FROM (" +
				"SELECT " + containerSeries + " AS series, instance_id, count() AS n, sum(" + val(keyOOMKill) + ") AS k " +
				"FROM app_instance_resources WHERE " + where + " AND " + has(keyOOMKill) + " GROUP BY series, instance_id" +
				") GROUP BY series)",
			args: args,
		}
	default: // MetricRestarts: the rows only tell whether the app reported resources.
		return evalQuery{
			sql:  "SELECT count(), nan FROM app_instance_resources WHERE " + where,
			args: args,
		}
	}
}
