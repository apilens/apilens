package retention

import (
	"os"
	"regexp"
	"strconv"
	"testing"

	"github.com/apilens/apilens/internal/platform/config"
)

func TestParseDays(t *testing.T) {
	for _, tc := range []struct {
		stmt string
		want int
		ok   bool
	}{
		{"CREATE TABLE apilens.api_requests (`timestamp` DateTime64(3)) ENGINE = MergeTree ORDER BY timestamp TTL toDateTime(timestamp) + toIntervalDay(90) SETTINGS ttl_only_drop_parts = 1, index_granularity = 8192", 90, true},
		{"CREATE TABLE apilens.api_requests_1h (`bucket` DateTime) ENGINE = AggregatingMergeTree ORDER BY bucket TTL bucket + toIntervalDay(400) SETTINGS index_granularity = 8192", 400, true},
		{"CREATE TABLE t (ts DateTime) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 7 DAY", 7, true},
		{"CREATE TABLE t (ts DateTime) ENGINE = MergeTree ORDER BY ts", 0, false},
	} {
		got, ok := ParseDays(tc.stmt)
		if got != tc.want || ok != tc.ok {
			t.Errorf("ParseDays(%q) = %d, %v; want %d, %v", tc.stmt, got, ok, tc.want, tc.ok)
		}
	}
}

func TestModifyTTL(t *testing.T) {
	if got := Signals[0].ModifyTTL(14); got != "ALTER TABLE api_requests MODIFY TTL toDateTime(timestamp) + INTERVAL 14 DAY" {
		t.Errorf("ModifyTTL = %q", got)
	}
}

// TestSignalsMatchSchema keeps the catalogue in step with the TTLs the
// ClickHouse schema creates and with the retention.* defaults.
func TestSignalsMatchSchema(t *testing.T) {
	raw, err := os.ReadFile("../migrations/clickhouse/00001_telemetry.sql")
	if err != nil {
		t.Fatal(err)
	}
	defaults := map[string]int{}
	for _, b := range config.RetentionBounds {
		defaults[b.Key] = b.Default
	}
	configurable := 0
	for _, s := range Signals {
		re := regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS ` + s.Table + `\s*\(.*?TTL ` + regexp.QuoteMeta(s.TimeExpr) + ` \+ INTERVAL (\d+) DAY`)
		m := re.FindSubmatch(raw)
		if m == nil {
			t.Errorf("%s: no TTL on %s in the schema", s.Key, s.TimeExpr)
			continue
		}
		schemaDays, _ := strconv.Atoi(string(m[1]))
		want := s.FixedDays
		if s.Configurable {
			configurable++
			d, ok := defaults[s.Key]
			if !ok {
				t.Errorf("%s: configurable but no retention.%s config key", s.Key, s.Key)
			}
			want = d
		}
		if schemaDays != want {
			t.Errorf("%s: schema TTL %d days, catalogue default %d", s.Key, schemaDays, want)
		}
		if s.Label == "" || s.Covers == "" {
			t.Errorf("%s: label and covers are required", s.Key)
		}
	}
	if configurable != len(config.RetentionBounds) {
		t.Errorf("%d configurable signals, %d retention.* keys", configurable, len(config.RetentionBounds))
	}
}
