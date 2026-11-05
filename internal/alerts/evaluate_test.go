package alerts

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func ptr[T any](v T) *T { return &v }

func TestMetricCatalogueMatchesSchema(t *testing.T) {
	// alert_rules.metric CHECK in 00016_alerts.sql.
	want := []string{"traffic", "errors", "error_rate", "p50", "p75", "p95", "apdex", "unique_consumers"}
	if len(Metrics) != len(want) {
		t.Fatalf("Metrics = %v, want %v", Metrics, want)
	}
	for i, m := range Metrics {
		if string(m) != want[i] || !m.Valid() {
			t.Errorf("Metrics[%d] = %q, want valid %q", i, m, want[i])
		}
	}
	if Metric("p99").Valid() {
		t.Error("p99 is not an alert metric")
	}
}

func TestConditionBreached(t *testing.T) {
	cases := []struct {
		c         Condition
		value     *float64
		threshold float64
		want      bool
	}{
		{ConditionGT, ptr(5.0), 5, false},
		{ConditionGT, ptr(5.1), 5, true},
		{ConditionGTE, ptr(5.0), 5, true},
		{ConditionGTE, ptr(4.9), 5, false},
		{ConditionLT, ptr(0.8), 0.9, true},
		{ConditionLT, ptr(0.9), 0.9, false},
		{ConditionLTE, ptr(0.9), 0.9, true},
		{ConditionLTE, ptr(1.0), 0.9, false},
		{ConditionGT, nil, -1, false},
		{ConditionLT, nil, 1e9, false},
		{Condition("eq"), ptr(1.0), 1, false},
	}
	for _, c := range cases {
		if got := c.c.Breached(c.value, c.threshold); got != c.want {
			v := "nil"
			if c.value != nil {
				v = fmt.Sprint(*c.value)
			}
			t.Errorf("%s(%s, %v) = %v, want %v", c.c, v, c.threshold, got, c.want)
		}
	}
}

func TestParseFilters(t *testing.T) {
	f, err := ParseFilters([]byte(`{"consumer":"alice","group":"` + uuid.Nil.String() + `","endpoint":"get /users/{id}","other":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if f.Consumer != "alice" || f.Group != uuid.Nil.String() {
		t.Errorf("filters = %+v", f)
	}
	if m, p := f.endpoint(); m != "GET" || p != "/users/{id}" {
		t.Errorf("endpoint = %q %q, want GET /users/{id}", m, p)
	}
	if m, p := (Filters{Endpoint: "/health"}).endpoint(); m != "" || p != "/health" {
		t.Errorf("path-only endpoint = %q %q", m, p)
	}
	if f, err := ParseFilters([]byte(`{}`)); err != nil || f != (Filters{}) {
		t.Errorf("empty filters = %+v, %v", f, err)
	}
	for _, bad := range []string{`[]`, `"x"`, `{"consumer":1}`} {
		if _, err := ParseFilters([]byte(bad)); !errors.Is(err, ErrInvalidFilters) {
			t.Errorf("ParseFilters(%s) = %v, want ErrInvalidFilters", bad, err)
		}
	}
}

func TestWindowAt(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 34, 56, 0, time.UTC)
	w := WindowAt(now, 300)
	if !w.End.Equal(time.Date(2026, 11, 5, 12, 34, 0, 0, time.UTC)) || !w.Start.Equal(w.End.Add(-5*time.Minute)) {
		t.Errorf("WindowAt(300) = %v", w)
	}
	if w := WindowAt(now, 90); w.End.Sub(w.Start) != 2*time.Minute {
		t.Errorf("90 s window spans %v, want 2m (rounded up)", w.End.Sub(w.Start))
	}
}

func TestDue(t *testing.T) {
	base := time.Date(2026, 11, 5, 12, 0, 37, 0, time.UTC)
	every := func(s int32, last *time.Time) Rule { return Rule{EveryS: &s, LastEvaluatedAt: last} }
	cronRule := func(spec string, last *time.Time) Rule { return Rule{Cron: &spec, LastEvaluatedAt: last} }
	cases := []struct {
		name string
		r    Rule
		now  time.Time
		want bool
	}{
		{"never evaluated", every(3600, nil), base, true},
		{"every minute, a minute later", every(60, &base), base.Add(time.Minute), true},
		{"every minute, run started early", every(60, &base), base.Add(59 * time.Second), true},
		{"every minute, same minute", every(60, &base), base.Add(20 * time.Second), false},
		{"every 5 min, 4 min later", every(300, &base), base.Add(4 * time.Minute), false},
		{"every 5 min, 5 min later", every(300, &base), base.Add(5 * time.Minute), true},
		{"cron 5 min, before tick", cronRule("*/5 * * * *", &base), base.Add(4 * time.Minute), false},
		{"cron 5 min, at tick", cronRule("*/5 * * * *", &base), time.Date(2026, 11, 5, 12, 5, 1, 0, time.UTC), true},
		{"cron hourly, next hour", cronRule("@hourly", &base), time.Date(2026, 11, 5, 13, 0, 3, 0, time.UTC), true},
		{"cron hourly, same hour", cronRule("@hourly", &base), time.Date(2026, 11, 5, 12, 59, 3, 0, time.UTC), false},
	}
	for _, c := range cases {
		got, err := c.r.Due(c.now)
		if err != nil || got != c.want {
			t.Errorf("%s: Due = %v, %v; want %v", c.name, got, err, c.want)
		}
	}
	// A tick is evaluated once: after evaluating at 12:05:01 the */5 rule
	// is not due again until 12:10.
	at := time.Date(2026, 11, 5, 12, 5, 1, 0, time.UTC)
	r := cronRule("*/5 * * * *", &at)
	for _, now := range []time.Time{at.Add(time.Minute), at.Add(4 * time.Minute)} {
		if due, _ := r.Due(now); due {
			t.Errorf("due again at %v", now)
		}
	}
	if due, _ := r.Due(at.Add(5 * time.Minute)); !due {
		t.Error("not due at the next tick")
	}
	if _, err := cronRule("not a cron", &base).Due(base); err == nil {
		t.Error("invalid cron: want error")
	}
}

func TestRuleFromRow(t *testing.T) {
	row := db.ListAlertRulesToEvaluateRow{
		ID: uuid.New(), Metric: "p95", Condition: "gt", Threshold: 250, WindowS: 300,
		EveryS: ptr(int32(60)), Filters: []byte(`{"endpoint":"GET /a"}`),
	}
	r, err := RuleFromRow(row)
	if err != nil || r.Metric != MetricP95 || r.Condition != ConditionGT || r.Filters.Endpoint != "GET /a" {
		t.Fatalf("RuleFromRow = %+v, %v", r, err)
	}
	row.Metric = "p99"
	if _, err := RuleFromRow(row); err == nil {
		t.Error("unknown metric: want error")
	}
	row.Metric, row.Condition = "p95", "eq"
	if _, err := RuleFromRow(row); err == nil {
		t.Error("unknown condition: want error")
	}
}

func TestBuildQuerySource(t *testing.T) {
	scope := queryScope{project: uuid.New(), app: uuid.New(), environment: "production", window: WindowAt(time.Now(), 300)}
	for _, m := range Metrics {
		for _, f := range []Filters{{}, {Endpoint: "GET /a"}, {Consumer: "alice"}, {Group: uuid.NewString()}} {
			s := scope
			s.filters = f
			q, err := buildQuery(m, s)
			if err != nil {
				t.Fatal(err)
			}
			rollup := strings.Contains(q.sql, "FROM api_requests_1m ")
			wantRollup := m != MetricApdex && m != MetricUniqueConsumers && f.Consumer == "" && f.Group == ""
			if rollup != wantRollup {
				t.Errorf("%s %+v: rollup = %v, want %v\n%s", m, f, rollup, wantRollup, q.sql)
			}
			if got := strings.Count(q.sql, "?"); got != len(q.args) {
				t.Errorf("%s %+v: %d placeholders, %d args\n%s", m, f, got, len(q.args), q.sql)
			}
		}
	}
	if _, err := buildQuery("p99", scope); err == nil {
		t.Error("unknown metric: want error")
	}
}

func TestApdexThresholdPrecedence(t *testing.T) {
	if e, args := (apdexThresholds{}).expr(); e != "500" || len(args) != 0 {
		t.Errorf("default = %q %v", e, args)
	}
	if e, _ := (apdexThresholds{app: 200}).expr(); e != "200" {
		t.Errorf("app = %q", e)
	}
	e, args := apdexThresholds{app: 200, endpoints: []endpointThreshold{{"GET", "/a", 50}}}.expr()
	if e != "multiIf(method = ? AND path = ?, 50, 200)" || len(args) != 2 || args[0] != "GET" || args[1] != "/a" {
		t.Errorf("endpoint = %q %v", e, args)
	}
}
