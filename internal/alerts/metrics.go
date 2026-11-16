package alerts

import (
	"encoding/json"
	"errors"
	"fmt"
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

// Metrics lists every metric, in catalogue order.
var Metrics = []Metric{
	MetricTraffic, MetricErrors, MetricErrorRate, MetricP50, MetricP75, MetricP95, MetricApdex, MetricUniqueConsumers,
}

// Valid reports whether m is a metric alert_rules accepts.
func (m Metric) Valid() bool {
	for _, v := range Metrics {
		if m == v {
			return true
		}
	}
	return false
}

// countLike reports whether m is a count, which is 0 (not "no data") over a
// window without requests.
func (m Metric) countLike() bool {
	return m == MetricTraffic || m == MetricErrors || m == MetricUniqueConsumers
}

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
