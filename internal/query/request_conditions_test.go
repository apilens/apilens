package query

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParseCondition(t *testing.T) {
	cases := map[string]condition{
		"status:eq:4xx":           {"status", "eq", "4xx"},
		"PATH:Contains:/a:b":      {"path", "contains", "/a:b"},
		"latency:between:10-200":  {"latency", "between", "10-200"},
		"consumer:ncontains: bot": {"consumer", "ncontains", "bot"},
		"trace_id:eq:abc":         {"trace_id", "eq", "abc"},
	}
	for in, want := range cases {
		got, err := parseCondition(in)
		if err != nil || got != want {
			t.Errorf("%q = %+v, %v; want %+v", in, got, err, want)
		}
	}
	for _, bad := range []string{"status", "status:eq", "status:eq:", "nope:eq:1", "method:contains:G", "payload:eq:x", "latency:eq:5", "path:eq:" + strings.Repeat("x", maxConditionValue+1)} {
		if _, err := parseCondition(bad); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestConditionFilterGroups(t *testing.T) {
	clauses, args, err := conditionFilter([]string{
		"status:eq:4xx", "status:eq:500", "method:neq:get", "path:contains:pay", "path:contains:ord",
		"latency:between:10-20", "consumer:neq:bob", "sampled:eq:true", "app:eq:6f1c8a52-37e8-4a43-8a8e-0e8f5f6f5a10",
	}, []string{"project_id = ?"}, []any{"p"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"project_id = ?",
		"NOT (method = ?)",
		"response_time_ms BETWEEN ? AND ?",
		"NOT ((consumer_id = ? OR consumer_name = ?))",
		"((status_code BETWEEN ? AND ?) OR (status_code BETWEEN ? AND ?))",
		"((path ILIKE ? OR raw_path ILIKE ?) OR (path ILIKE ? OR raw_path ILIKE ?))",
		"sampled = 1",
		"app_id = ?",
	}
	if !slices.Equal(clauses, want) {
		t.Fatalf("clauses =\n%q\nwant\n%q", clauses, want)
	}
	if n := strings.Count(strings.Join(clauses, " "), "?"); n != len(args) {
		t.Fatalf("%d placeholders, %d args: %v", n, len(args), args)
	}
	if args[1] != "GET" || args[2] != 10.0 || args[3] != 20.0 {
		t.Fatalf("args = %v", args)
	}
	for _, bad := range []string{"app:eq:x", "status:neq:9xx", "latency:between:5", "latency:between:9-1", "request_size:gt:-1", "sampled:eq:maybe"} {
		if _, _, err := conditionFilter([]string{bad}, nil, nil); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
	if _, _, err := conditionFilter(make([]string, maxConditions+1), nil, nil); err == nil {
		t.Error("too many conditions accepted")
	}
}

func TestPathConditionMatchesRawURLs(t *testing.T) {
	// A route template matches exactly; other text also the raw URLs containing it, as the path parameter does.
	if sql, _, _ := conditionClause(condition{"path", "eq", "/orders/{id}"}); sql != "path = ?" {
		t.Fatalf("template: %s", sql)
	}
	if sql, args, _ := conditionClause(condition{"path", "neq", "/orders/42"}); sql != "(path = ? OR raw_path ILIKE ?)" || args[1] != "%/orders/42%" {
		t.Fatalf("raw: %s %v", sql, args)
	}
}

func TestWithoutField(t *testing.T) {
	got := withoutField([]string{"status:eq:4xx", "Status:neq:500", "method:eq:GET", "status"}, "status")
	if !slices.Equal(got, []string{"method:eq:GET"}) {
		t.Fatalf("got %q", got)
	}
}

func TestRequestFilterTakesConditions(t *testing.T) {
	in := &requestsInput{Method: "post", Filter: []string{"status:neq:5xx"}}
	clauses, _, err := requestFilter(in, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(clauses, []string{"method = ?", "NOT ((status_code BETWEEN ? AND ?))"}) {
		t.Fatalf("clauses = %q", clauses)
	}
	if _, _, err := requestFilter(&requestsInput{Filter: []string{"bogus"}}, nil, nil); err == nil {
		t.Fatal("bad condition accepted")
	}
}

func TestFacetQuery(t *testing.T) {
	q, args, err := facetQuery("consumer", "ali", 200, []string{"project_id = ?"}, []any{"p"})
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"SELECT consumer_id AS v, any(consumer_name) AS l, count() AS n", "consumer_id != ''", "(consumer_id ILIKE ? OR consumer_name ILIKE ?)", "GROUP BY v ORDER BY n DESC, v LIMIT ?"} {
		if !strings.Contains(q, part) {
			t.Errorf("query lacks %q:\n%s", part, q)
		}
	}
	// The limit is capped at maxFacetValues.
	if len(args) != 4 || args[1] != "%ali%" || args[3] != maxFacetValues {
		t.Fatalf("args = %v", args)
	}
	// search only narrows the fields that take it.
	q, args, _ = facetQuery("status", "50", 20, []string{"project_id = ?"}, []any{"p"})
	if strings.Contains(q, "ILIKE") || len(args) != 2 {
		t.Fatalf("status facet: %s %v", q, args)
	}
	if _, _, err := facetQuery("ip", "", 10, nil, nil); err == nil {
		t.Fatal("unknown facet accepted")
	}
}

func TestTimelineBucketWidths(t *testing.T) {
	if timelineBucketWidths["minute"] != time.Minute || timelineBucketWidths["day"] != 24*time.Hour {
		t.Fatal("bucket widths")
	}
	// 7 days at one minute would be 10080 bars, past maxFixedBuckets: the auto width applies.
	if 7*24*time.Hour <= timelineBucketWidths["minute"]*maxFixedBuckets {
		t.Fatal("a week of minutes fits")
	}
}
