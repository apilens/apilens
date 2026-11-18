//go:build integration

package query_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

type traceRead struct {
	Spans []struct {
		SpanID        string            `json:"span_id"`
		Status        string            `json:"status"`
		StatusCode    uint16            `json:"status_code"`
		StatusMessage string            `json:"status_message"`
		Attributes    map[string]string `json:"attributes"`
		Events        []struct {
			Time       time.Time         `json:"time"`
			Name       string            `json:"name"`
			Attributes map[string]string `json:"attributes"`
		} `json:"events"`
		Links []struct {
			TraceID string `json:"trace_id"`
			SpanID  string `json:"span_id"`
		} `json:"links"`
	} `json:"spans"`
	Logs []struct {
		Message    string            `json:"message"`
		LoggerName string            `json:"logger_name"`
		Payload    string            `json:"payload"`
		Attributes map[string]string `json:"attributes"`
	} `json:"logs"`
	Truncated bool `json:"truncated"`
}

// TestTraceReturnsExceptionPayloadAndSpanDetail checks GET /traces/{id}
// returns the exception log's payload, logger and attributes, and each
// span's attributes, status message, events and links.
func TestTraceReturnsExceptionPayloadAndSpanDetail(t *testing.T) {
	ctx, conn, mine, _, get := endpointRequestsEnv(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	const trace = "cccc0000000000000000000000000001"
	ins := pipeline.ClickHouseInserters(conn)
	at := now.Add(-time.Minute + 3*time.Millisecond + 7)
	payload := `{"type":"builtins.ValueError","message":"card declined","frames":[{"file":"pay.py","line":3}],"causes":[{"type":"KeyError"}]}`
	if err := ins.Spans(ctx, []pipeline.SpanRow{
		{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute),
			TraceID: trace, SpanID: "00000000000000c1", Name: "POST /charge", Kind: "server", Status: "error", StatusCode: 500,
			StatusMessage: "ValueError: card declined", Attributes: map[string]string{"http.route": "/charge"},
			Events: []pipeline.SpanEventRow{{Time: at, Name: "exception", Attributes: map[string]string{
				"exception.type": "builtins.ValueError", "exception.stacktrace": "Traceback (most recent call last): ...",
			}}},
			Links: []pipeline.SpanLink{{TraceID: "dddd0000000000000000000000000001", SpanID: "00000000000000d1"}},
		},
		// An older SDK's span: no message, events or links, never null.
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute + time.Millisecond), TraceID: trace, SpanID: "00000000000000c2", ParentSpanID: "00000000000000c1", Name: "SELECT cards", Kind: "client", Status: "ok"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := ins.Logs(ctx, []pipeline.LogRow{{
		ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute), Level: "ERROR",
		Message: "ValueError: card declined", LoggerName: "apilens.exception", TraceID: trace, SpanID: "00000000000000c1",
		Payload: payload, Attributes: map[string]string{"exception.type": "builtins.ValueError", "exception.chain_depth": "2"},
	}}); err != nil {
		t.Fatal(err)
	}

	var tr traceRead
	if code := get(mine.ReadKey, "/api/v1/traces/"+trace, &tr); code != 200 || len(tr.Spans) != 2 || len(tr.Logs) != 1 {
		t.Fatalf("trace = %d %+v", code, tr)
	}
	if tr.Truncated {
		t.Error("a small trace must not be truncated")
	}
	sp := tr.Spans[0]
	if sp.SpanID != "00000000000000c1" || sp.Status != "error" || sp.StatusCode != 500 || sp.StatusMessage != "ValueError: card declined" ||
		sp.Attributes["http.route"] != "/charge" {
		t.Errorf("span = %+v", sp)
	}
	if len(sp.Events) != 1 || sp.Events[0].Name != "exception" || !sp.Events[0].Time.Equal(at) ||
		sp.Events[0].Attributes["exception.type"] != "builtins.ValueError" ||
		sp.Events[0].Attributes["exception.stacktrace"] != "Traceback (most recent call last): ..." {
		t.Errorf("events = %+v", sp.Events)
	}
	if len(sp.Links) != 1 || sp.Links[0].TraceID != "dddd0000000000000000000000000001" || sp.Links[0].SpanID != "00000000000000d1" {
		t.Errorf("links = %+v", sp.Links)
	}
	if old := tr.Spans[1]; old.StatusMessage != "" || old.Events == nil || len(old.Events) != 0 || old.Links == nil || old.Attributes == nil {
		t.Errorf("older span = %+v, want empty (not null) events, links and attributes", old)
	}
	l := tr.Logs[0]
	if l.LoggerName != "apilens.exception" || l.Payload != payload || l.Attributes["exception.chain_depth"] != "2" ||
		l.Attributes["exception.type"] != "builtins.ValueError" {
		t.Errorf("log = %+v", l)
	}
}

// TestTraceTruncatedOverTheLimit checks a trace with more than 10000 spans
// and 2000 logs answers the oldest 10000 and 2000 with truncated set, and a
// trace exactly at the limit is not truncated.
func TestTraceTruncatedOverTheLimit(t *testing.T) {
	ctx, conn, mine, _, get := endpointRequestsEnv(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	const trace = "eeee0000000000000000000000000001"
	ins := pipeline.ClickHouseInserters(conn)
	spans := make([]pipeline.SpanRow, 10001)
	for i := range spans {
		spans[i] = pipeline.SpanRow{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production",
			Timestamp: now.Add(-time.Hour + time.Duration(i)*time.Millisecond), TraceID: trace, SpanID: fmt.Sprintf("%016x", i+1), Name: "work", Kind: "internal"}
	}
	logs := make([]pipeline.LogRow, 2001)
	for i := range logs {
		logs[i] = pipeline.LogRow{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production",
			Timestamp: now.Add(-time.Hour + time.Duration(i)*time.Millisecond), Level: "INFO", Message: "step", TraceID: trace}
	}
	if err := ins.Spans(ctx, spans); err != nil {
		t.Fatal(err)
	}
	if err := ins.Logs(ctx, logs); err != nil {
		t.Fatal(err)
	}
	var tr traceRead
	if code := get(mine.ReadKey, "/api/v1/traces/"+trace, &tr); code != 200 || len(tr.Spans) != 10000 || len(tr.Logs) != 2000 || !tr.Truncated {
		t.Fatalf("trace = %d spans=%d logs=%d truncated=%v", code, len(tr.Spans), len(tr.Logs), tr.Truncated)
	}
	if tr.Spans[0].SpanID != fmt.Sprintf("%016x", 1) {
		t.Errorf("first span = %s, want the oldest", tr.Spans[0].SpanID)
	}

	const full = "eeee0000000000000000000000000002"
	for i := range spans[:10000] {
		spans[i].TraceID = full
	}
	if err := ins.Spans(ctx, spans[:10000]); err != nil {
		t.Fatal(err)
	}
	tr = traceRead{}
	if code := get(mine.ReadKey, "/api/v1/traces/"+full, &tr); code != 200 || len(tr.Spans) != 10000 || tr.Truncated {
		t.Fatalf("full trace = %d spans=%d truncated=%v", code, len(tr.Spans), tr.Truncated)
	}
}
