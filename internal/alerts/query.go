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
// any consumer or group filter (the rollup has no consumer column).
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
	// members are the consumer ids of filters.Group, resolved by the caller.
	members []string
	apdex   apdexThresholds
}

// buildQuery builds the query of metric m over s.
func buildQuery(m Metric, s queryScope) (evalQuery, error) {
	if !m.Valid() {
		return evalQuery{}, fmt.Errorf("alerts: unknown metric %q", m)
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
		members := s.members
		if members == nil {
			members = []string{}
		}
		where, args = append(where, "has(?, consumer_id)"), append(args, members)
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
