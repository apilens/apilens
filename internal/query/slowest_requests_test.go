package query

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSlowestRequestsQuery checks the slowest-requests read (#1001): scoped
// to the project, environment, app and range, excluded endpoints left out,
// slowest first and capped.
func TestSlowestRequestsQuery(t *testing.T) {
	project, app := uuid.New(), uuid.New()
	from := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	w := window{from: from, to: from.Add(time.Hour)}
	rules := metricRules{excluded: []endpointKey{{app: app, method: "GET", path: "/health"}}}

	in := &slowestRequestsInput{Limit: 10}
	in.Env, in.App = "production", app.String()
	sql, args, err := slowestRequestsQuery(project, in, rules, w)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"FROM api_requests WHERE project_id = ? AND environment = ? AND app_id = ?",
		"AND NOT ((app_id = ? AND method = ? AND path = ?))",
		"AND timestamp >= ? AND timestamp < ?",
		"ORDER BY response_time_ms DESC, timestamp DESC, trace_id DESC LIMIT ?",
		"span_id",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("query lacks %q:\n%s", want, sql)
		}
	}
	if got := strings.Count(sql, "?"); got != len(args) {
		t.Fatalf("%d placeholders, %d args %v", got, len(args), args)
	}
	if args[0] != project || args[1] != "production" || args[len(args)-3] != w.from || args[len(args)-2] != w.to || args[len(args)-1] != 10 {
		t.Fatalf("args = %v", args)
	}

	// Every app and environment: the project and the range only; the limit is capped.
	sql, args, err = slowestRequestsQuery(project, &slowestRequestsInput{Limit: 500}, metricRules{}, w)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "WHERE project_id = ? AND timestamp >= ?") || len(args) != 4 || args[3] != maxSlowestRequests {
		t.Fatalf("unscoped: %v\n%s", args, sql)
	}

	bad := &slowestRequestsInput{}
	bad.App = "not-a-uuid"
	if _, _, err := slowestRequestsQuery(project, bad, metricRules{}, w); err == nil {
		t.Fatal("a malformed app id was accepted")
	}
}
