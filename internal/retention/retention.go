// Package retention describes how long ClickHouse keeps each telemetry
// signal: the tables, their TTL expressions and the labels the API shows
// (D10). The periods live in the table TTLs; `apilens migrate` sets them from
// the retention.* config and the query role reads them back from
// system.tables, so what the API reports is what ClickHouse enforces.
package retention

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/apilens/apilens/internal/platform/config"
)

// Signal is one kind of stored telemetry with its own retention.
type Signal struct {
	// Key is the API identifier and, when Configurable, the retention.*
	// config key.
	Key string
	// Table is the ClickHouse table whose TTL holds the period.
	Table string
	// TimeExpr is the left side of the TTL expression (the row's time).
	TimeExpr string
	// Label and Covers are the human description the API returns.
	Label, Covers string
	// Configurable reports whether an install may change the period
	// through retention.<Key>.
	Configurable bool
	// FixedDays is the period of a signal that is not configurable.
	FixedDays int
}

// Signals lists every signal in display order.
var Signals = []Signal{
	{Key: "requests", Table: "api_requests", TimeExpr: "toDateTime(timestamp)", Configurable: true,
		Label: "Requests", Covers: "Individual requests: the request log, request detail with headers and bodies, consumers and exports."},
	{Key: "logs", Table: "api_logs", TimeExpr: "toDateTime(timestamp)", Configurable: true,
		Label: "Logs", Covers: "Application log records sent by the SDK, shown with a request's trace."},
	{Key: "spans", Table: "api_spans", TimeExpr: "toDateTime(timestamp)", Configurable: true,
		Label: "Spans", Covers: "Trace spans: the waterfall in request detail."},
	{Key: "rollups_1m", Table: "api_requests_1m", TimeExpr: "bucket", Configurable: true,
		Label: "Per-minute metrics", Covers: "Per-minute traffic, error and latency aggregates behind short-range charts."},
	{Key: "rollups_1h", Table: "api_requests_1h", TimeExpr: "bucket", Configurable: true,
		Label: "Hourly metrics", Covers: "Hourly traffic, error and latency aggregates behind long-range charts."},
	{Key: "deploys", Table: "api_deploys", TimeExpr: "toDateTime(deployed_at)", FixedDays: 400,
		Label: "Deploys", Covers: "Deploy markers on charts and the deploy comparison."},
}

// Days returns the period the config asks for: retention.<Key> for a
// configurable signal, FixedDays otherwise.
func (s Signal) Days(cfg config.RetentionConfig) int {
	if s.Configurable {
		return cfg.Days(s.Key)
	}
	return s.FixedDays
}

// ModifyTTL is the DDL that sets the signal's period to days.
func (s Signal) ModifyTTL(days int) string {
	return fmt.Sprintf("ALTER TABLE %s MODIFY TTL %s + INTERVAL %d DAY", s.Table, s.TimeExpr, days)
}

// TablesQuery reads the CREATE statements of every signal table in the
// current database; scan (name, create_table_query) and pass each statement
// to ParseDays.
var TablesQuery = func() string {
	names := make([]string, len(Signals))
	for i, s := range Signals {
		names[i] = "'" + s.Table + "'"
	}
	return "SELECT name, create_table_query FROM system.tables WHERE database = currentDatabase() AND name IN (" +
		strings.Join(names, ", ") + ")"
}()

// ttlRE matches the table TTL in the statement ClickHouse stores, which
// normalizes `INTERVAL n DAY` to toIntervalDay(n).
var ttlRE = regexp.MustCompile(`\bTTL\s+.*?\+\s*(?:toIntervalDay\((\d+)\)|INTERVAL\s+(\d+)\s+DAY)`)

// ParseDays extracts the table TTL in days from a CREATE TABLE statement.
func ParseDays(createTable string) (int, bool) {
	m := ttlRE.FindStringSubmatch(createTable)
	if m == nil {
		return 0, false
	}
	v := m[1]
	if v == "" {
		v = m[2]
	}
	n, err := strconv.Atoi(v)
	return n, err == nil
}
