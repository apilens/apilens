package retention

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"slices"
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
// ClickHouse schema ends up with (the CREATE in 00001 or a later migration, then any later
// migration's MODIFY TTL) and with the retention.* defaults.
func TestSignalsMatchSchema(t *testing.T) {
	raw, err := os.ReadFile("../migrations/clickhouse/00001_telemetry.sql")
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../migrations/clickhouse/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	var ups [][]byte // the Up section of each migration after 00001, in order
	for _, f := range files[1:] {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		up, _, _ := bytes.Cut(b, []byte("-- +goose Down"))
		ups = append(ups, up)
	}
	defaults := map[string]int{}
	for _, b := range config.RetentionBounds {
		defaults[b.Key] = b.Default
	}
	configurable := 0
	for _, s := range Signals {
		re := regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS ` + s.Table + `\s*\(.*?TTL ` + regexp.QuoteMeta(s.TimeExpr) + ` \+ INTERVAL (\d+) DAY`)
		m := re.FindSubmatch(raw)
		for _, up := range ups { // a table created by a later migration (M7 resources)
			if m == nil {
				m = re.FindSubmatch(up)
			}
		}
		if m == nil {
			t.Errorf("%s: no TTL on %s in the schema", s.Key, s.TimeExpr)
			continue
		}
		schemaDays, _ := strconv.Atoi(string(m[1]))
		modify := regexp.MustCompile(`ALTER TABLE ` + s.Table + ` MODIFY TTL ` + regexp.QuoteMeta(s.TimeExpr) + ` \+ INTERVAL (\d+) DAY`)
		for _, up := range ups {
			for _, mm := range modify.FindAllSubmatch(up, -1) {
				schemaDays, _ = strconv.Atoi(string(mm[1]))
			}
		}
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
