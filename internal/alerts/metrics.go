package alerts

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Metric is alert_rules.metric: what a rule aggregates over its window.
// The catalogue matches Apitally's alert metrics.
type Metric string

// The metrics alert_rules accepts. Over a rule's window (requests of the
// rule's app and environment, narrowed by its filters):
const (
	// MetricTraffic is the number of requests.
	MetricTraffic Metric = "traffic"
	// MetricErrors is the number of requests answered 4xx or 5xx.
	MetricErrors Metric = "errors"
	// MetricErrorRate is errors / requests, a fraction from 0 to 1.
	MetricErrorRate Metric = "error_rate"
	// MetricServerErrors is the number of requests answered 5xx.
	MetricServerErrors Metric = "server_errors"
	// MetricServerErrorRate is server errors / requests, from 0 to 1.
	MetricServerErrorRate Metric = "server_error_rate"
	// MetricClientErrors is the number of requests answered 4xx.
	MetricClientErrors Metric = "client_errors"
	// MetricClientErrorRate is client errors / requests, from 0 to 1.
	MetricClientErrorRate Metric = "client_error_rate"
	// MetricP50 is the median response time in milliseconds.
	MetricP50 Metric = "p50"
	// MetricP75 is the 75th percentile response time in milliseconds.
	MetricP75 Metric = "p75"
	// MetricP95 is the 95th percentile response time in milliseconds.
	MetricP95 Metric = "p95"
	// MetricApdex is the Apdex score from 0 to 1, with the threshold T of
	// each request's endpoint, else its app, else 500 ms (as the dashboard).
	MetricApdex Metric = "apdex"
	// MetricUniqueConsumers is the number of distinct identified consumers.
	MetricUniqueConsumers Metric = "unique_consumers"
)

// The resource metrics (M7) read the SDK heartbeats' runtime resources
// (ClickHouse app_instance_resources) of the rule's app and environment
// instead of its requests; filters do not apply to them. A container metric
// is one series per container_id however many workers report it (an
// instance without a container_id is its own series), a process metric one
// series per instance. The gauges are aggregated per series over the window
// and then over the series by the rule's Aggregation (max by default).
const (
	// MetricCPUPctOfLimit is CPU use as a percent of the CPU limit, 0 to
	// 100: the container's where reported, else the process's.
	MetricCPUPctOfLimit Metric = "cpu_pct_of_limit"
	// MetricMemoryPctOfLimit is the container's memory working set as a
	// percent of its memory limit, 0 to 100.
	MetricMemoryPctOfLimit Metric = "memory_pct_of_limit"
	// MetricCPUThrottledRatio is the fraction of the container's CPU
	// periods that were throttled, 0 to 1.
	MetricCPUThrottledRatio Metric = "cpu_throttled_ratio"
	// MetricEventLoopP99 is the Node.js event-loop delay p99 in ms.
	MetricEventLoopP99 Metric = "event_loop_p99_ms"
	// MetricGCPausePct is the time a process spent in GC pauses as a
	// percent of the heartbeat window, 0 to 100 (JVM, Node.js and Python).
	MetricGCPausePct Metric = "gc_pause_pct"
	// MetricOOMKills is the number of OOM kills the containers recorded
	// (cgroup memory.events oom_kill), each container counted once.
	MetricOOMKills Metric = "oom_kills"
	// MetricRestarts is the number of restarts the server inferred (restart,
	// oom and suspected_oom instance events); the workers of a container
	// replaced together count once.
	MetricRestarts Metric = "restarts"
)

// RequestMetrics lists the metrics over requests, in catalogue order.
var RequestMetrics = []Metric{
	MetricTraffic, MetricErrors, MetricErrorRate,
	MetricServerErrors, MetricServerErrorRate, MetricClientErrors, MetricClientErrorRate,
	MetricP50, MetricP75, MetricP95, MetricApdex, MetricUniqueConsumers,
}

// ResourceMetrics lists the metrics over runtime resources, in catalogue
// order.
var ResourceMetrics = []Metric{
	MetricCPUPctOfLimit, MetricMemoryPctOfLimit, MetricCPUThrottledRatio,
	MetricEventLoopP99, MetricGCPausePct, MetricOOMKills, MetricRestarts,
}

// Metrics lists every metric, in catalogue order.
var Metrics = append(slices.Clone(RequestMetrics), ResourceMetrics...)

// Valid reports whether m is a metric alert_rules accepts.
func (m Metric) Valid() bool {
	for _, v := range Metrics {
		if m == v {
			return true
		}
	}
	return false
}

// IsResource reports whether m reads runtime resources, not requests.
func (m Metric) IsResource() bool { return slices.Contains(ResourceMetrics, m) }

// IsGauge reports whether m is a resource gauge, aggregated over instances
// by the rule's Aggregation. The resource counts are totals.
func (m Metric) IsGauge() bool {
	return m.IsResource() && m != MetricOOMKills && m != MetricRestarts
}

// IsPercent reports whether m is a percent from 0 to 100.
func (m Metric) IsPercent() bool {
	return m == MetricCPUPctOfLimit || m == MetricMemoryPctOfLimit || m == MetricGCPausePct
}

// countLike reports whether m is a count, which is 0 (not "no data") over a
// window without requests. The resource counts are not: they are 0 only
// over a window with resource rows (see Evaluator.Evaluate).
func (m Metric) countLike() bool {
	switch m {
	case MetricTraffic, MetricErrors, MetricServerErrors, MetricClientErrors, MetricUniqueConsumers:
		return true
	}
	return false
}

// IsRate reports whether m is a fraction from 0 to 1: of the requests, or
// of the CPU periods for cpu_throttled_ratio.
func (m Metric) IsRate() bool {
	return m == MetricErrorRate || m == MetricServerErrorRate || m == MetricClientErrorRate || m == MetricCPUThrottledRatio
}

// Aggregation is alert_rules.aggregation: how a resource gauge combines
// over the instances (series) of the app. Request metrics and the resource
// counts ignore it.
type Aggregation string

// The aggregations alert_rules accepts.
const (
	// AggregationMax is the worst series: each series' peak (the gauges'
	// max) over the window, the highest of them. The default.
	AggregationMax Aggregation = "max"
	// AggregationAvg is each series' average (the gauges' avg) over the
	// window, averaged over the series.
	AggregationAvg Aggregation = "avg"
)

// Valid reports whether a is an aggregation alert_rules accepts.
func (a Aggregation) Valid() bool { return a == AggregationMax || a == AggregationAvg }

// Condition is alert_rules.condition: how a value compares to the
// threshold for the rule to be breached.
type Condition string

// The conditions alert_rules accepts.
const (
	ConditionGT  Condition = "gt"
	ConditionGTE Condition = "gte"
	ConditionLT  Condition = "lt"
	ConditionLTE Condition = "lte"
)

// Valid reports whether c is a condition alert_rules accepts.
func (c Condition) Valid() bool {
	switch c {
	case ConditionGT, ConditionGTE, ConditionLT, ConditionLTE:
		return true
	}
	return false
}

// Breached reports whether value compares to threshold by c. A nil value
// (no data) never breaches.
func (c Condition) Breached(value *float64, threshold float64) bool {
	if value == nil {
		return false
	}
	v := *value
	switch c {
	case ConditionGT:
		return v > threshold
	case ConditionGTE:
		return v >= threshold
	case ConditionLT:
		return v < threshold
	case ConditionLTE:
		return v <= threshold
	}
	return false
}

// Filters is alert_rules.filters: what narrows the requests a rule counts.
// Every key is optional.
//
//   - consumer: a consumer id, as the SDK reports it.
//   - group: a consumer group name, as the SDK reports it (consumer_group
//     on each request); the requests tagged with it are counted.
//   - endpoint: "METHOD /route/{template}" or just "/route/{template}" for
//     every method, matching the endpoint path the dashboard shows.
type Filters struct {
	Consumer string `json:"consumer,omitempty"`
	Group    string `json:"group,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
}

// ErrInvalidFilters is returned for filters that are not a JSON object of
// strings.
var ErrInvalidFilters = errors.New("alerts: rule filters must be a JSON object of strings")

// ParseFilters decodes alert_rules.filters. Unknown keys are ignored.
func ParseFilters(b []byte) (Filters, error) {
	var f Filters
	if len(b) == 0 {
		return f, nil
	}
	if !isJSONObject(b) {
		return f, ErrInvalidFilters
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("%w: %w", ErrInvalidFilters, err)
	}
	return f, nil
}

// endpoint splits the endpoint filter into method ("" for any) and path.
func (f Filters) endpoint() (method, path string) {
	e := strings.TrimSpace(f.Endpoint)
	if m, p, ok := strings.Cut(e, " "); ok && !strings.HasPrefix(m, "/") {
		return strings.ToUpper(m), strings.TrimSpace(p)
	}
	return "", e
}

// byConsumer reports whether f narrows by consumer or consumer group,
// which the per-minute rollup cannot answer.
func (f Filters) byConsumer() bool { return f.Consumer != "" || f.Group != "" }

// Window is the minute-aligned span a rule aggregates over: [Start, End).
type Window struct {
	Start, End time.Time
}

// WindowAt is the window of windowS seconds ending at the start of the
// minute of now, so the minute still being written is left out. windowS is
// rounded up to whole minutes.
func WindowAt(now time.Time, windowS int32) Window {
	end := now.UTC().Truncate(time.Minute)
	minutes := (int64(windowS) + 59) / 60
	if minutes < 1 {
		minutes = 1
	}
	return Window{Start: end.Add(-time.Duration(minutes) * time.Minute), End: end}
}
