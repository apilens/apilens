//go:build integration

package query_test

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

type requestDetailResp struct {
	Request struct {
		ID               string            `json:"id"`
		Timestamp        time.Time         `json:"timestamp"`
		Method           string            `json:"method"`
		Path             string            `json:"path"`
		RawPath          string            `json:"raw_path"`
		StatusCode       int               `json:"status_code"`
		ConsumerID       string            `json:"consumer_id"`
		TraceID          string            `json:"trace_id"`
		SpanID           string            `json:"span_id"`
		UserAgent        string            `json:"user_agent"`
		Release          string            `json:"release"`
		RequestHeaders   string            `json:"request_headers"`
		ResponseHeaders  string            `json:"response_headers"`
		RequestBody      string            `json:"request_body"`
		ResponseBody     string            `json:"response_body"`
		Attributes       map[string]string `json:"attributes"`
		Sampled          bool              `json:"sampled"`
		ValidationErrors []struct {
			Loc  string `json:"loc"`
			Msg  string `json:"msg"`
			Type string `json:"type"`
		} `json:"validation_errors"`
	} `json:"request"`
	Spans []struct {
		SpanID string `json:"span_id"`
		Name   string `json:"name"`
	} `json:"spans"`
	Logs []struct {
		Message string `json:"message"`
		SpanID  string `json:"span_id"`
	} `json:"logs"`
}

// TestRequestDetail checks GET /api/v1/requests/{id}: one call returns the
// record, its headers and bodies as stored, validation errors and its
// trace's spans and logs; unknown ids and other projects' ids are 404.
func TestRequestDetail(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	const trace = "bbbb0000000000000000000000000001"
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, []pipeline.RequestRow{
		{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute),
			Method: "POST", Path: "/orders", RawPath: "/orders?token=[redacted]", StatusCode: 422, ResponseTimeMs: 31.5,
			RequestSize: 12, ResponseSize: 80, IPAddress: "10.0.0.9", UserAgent: "curl/8", ConsumerID: "alice",
			RequestPayload:  `{"qty":-1,"card":"[redacted]"}`,
			ResponsePayload: `{"detail":[{"loc":["body","qty"],"msg":"must be positive"}]}`,
			RequestHeaders:  `{"authorization":"[redacted]","content-type":"application/json"}`,
			ResponseHeaders: `{"content-type":"application/json"}`,
			TraceID:         trace, SpanID: "00000000000000a1", Release: "1.2.3", Sampled: true,
			Attributes:       map[string]string{"tenant": "acme"},
			ValidationErrors: []pipeline.ValidationError{{Loc: "body.qty", Msg: "must be positive", Type: "value_error"}},
		},
		// Same trace, a different span: a second request the id must not confuse.
		{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute),
			Method: "GET", Path: "/stock", RawPath: "/stock", StatusCode: 200, TraceID: trace, SpanID: "00000000000000b2", Sampled: true,
		},
		// No trace: no spans or logs, and no lookup by an empty trace id.
		{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Minute),
			Method: "GET", Path: "/health", RawPath: "/health", StatusCode: 200, Sampled: false,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := ins.Spans(ctx, []pipeline.SpanRow{
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute), TraceID: trace, SpanID: "00000000000000a1", Name: "POST /orders", Kind: "server", Status: "error", StatusCode: 422},
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-2*time.Minute + time.Millisecond), TraceID: trace, SpanID: "00000000000000a2", ParentSpanID: "00000000000000a1", Name: "SELECT orders", Kind: "client", Status: "ok"},
		// Another project's span on the same trace id never shows.
		{ProjectID: theirs.ProjectID, AppID: theirs.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute), TraceID: trace, SpanID: "00000000000000ff", Name: "theirs", Kind: "server"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := ins.Logs(ctx, []pipeline.LogRow{
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute), Level: "WARNING", Message: "qty rejected", TraceID: trace, SpanID: "00000000000000a1"},
		{ProjectID: theirs.ProjectID, AppID: theirs.AppID, Environment: "production", Timestamp: now.Add(-2 * time.Minute), Level: "ERROR", Message: "theirs", TraceID: trace},
	}); err != nil {
		t.Fatal(err)
	}

	var ids struct {
		Requests []struct {
			ID      string `json:"id"`
			RawPath string `json:"raw_path"`
		} `json:"requests"`
	}
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h", &ids); code != http.StatusOK || len(ids.Requests) != 3 {
		t.Fatalf("request log = %d %+v", code, ids)
	}
	byPath := map[string]string{}
	for _, r := range ids.Requests {
		if r.ID == "" {
			t.Fatalf("row %q has no id", r.RawPath)
		}
		byPath[r.RawPath] = r.ID
	}

	var d requestDetailResp
	if code := get(mine.ReadKey, "/api/v1/requests/"+url.PathEscape(byPath["/orders?token=[redacted]"]), &d); code != http.StatusOK {
		t.Fatalf("detail status %d", code)
	}
	r := d.Request
	if r.ID != byPath["/orders?token=[redacted]"] || r.Method != "POST" || r.Path != "/orders" || r.StatusCode != 422 ||
		r.ConsumerID != "alice" || r.SpanID != "00000000000000a1" || r.UserAgent != "curl/8" || r.Release != "1.2.3" ||
		!r.Sampled || !r.Timestamp.Equal(now.Add(-2*time.Minute)) {
		t.Fatalf("record = %+v", r)
	}
	if r.RequestHeaders != `{"authorization":"[redacted]","content-type":"application/json"}` ||
		r.ResponseHeaders != `{"content-type":"application/json"}` ||
		r.RequestBody != `{"qty":-1,"card":"[redacted]"}` ||
		r.ResponseBody != `{"detail":[{"loc":["body","qty"],"msg":"must be positive"}]}` {
		t.Fatalf("headers/bodies not returned as stored: %+v", r)
	}
	if r.Attributes["tenant"] != "acme" {
		t.Fatalf("attributes = %v", r.Attributes)
	}
	if len(r.ValidationErrors) != 1 || r.ValidationErrors[0].Loc != "body.qty" || r.ValidationErrors[0].Type != "value_error" {
		t.Fatalf("validation_errors = %+v", r.ValidationErrors)
	}
	if len(d.Spans) != 2 || d.Spans[0].Name != "POST /orders" || d.Spans[1].Name != "SELECT orders" {
		t.Fatalf("spans = %+v", d.Spans)
	}
	if len(d.Logs) != 1 || d.Logs[0].Message != "qty rejected" {
		t.Fatalf("logs = %+v", d.Logs)
	}

	// The sibling request of the same trace resolves to itself.
	var sib requestDetailResp
	if code := get(mine.ReadKey, "/api/v1/requests/"+byPath["/stock"], &sib); code != http.StatusOK || sib.Request.Path != "/stock" || len(sib.Spans) != 2 {
		t.Fatalf("sibling = %d %+v", code, sib.Request)
	}

	// Without a trace: empty spans, logs and validation errors, never null.
	var bare requestDetailResp
	if code := get(mine.ReadKey, "/api/v1/requests/"+byPath["/health"], &bare); code != http.StatusOK {
		t.Fatalf("bare status %d", code)
	}
	if bare.Spans == nil || len(bare.Spans) != 0 || bare.Logs == nil || len(bare.Logs) != 0 ||
		bare.Request.ValidationErrors == nil || bare.Request.Sampled || bare.Request.Attributes == nil {
		t.Fatalf("bare = %+v", bare)
	}

	// Unknown, malformed and other-project ids are 404.
	unknown := base64.RawURLEncoding.EncodeToString([]byte("1:" + trace + ":00000000000000a1"))
	for name, c := range map[string]struct {
		key, id string
	}{
		"unknown":       {mine.ReadKey, unknown},
		"malformed":     {mine.ReadKey, "not-an-id"},
		"other project": {theirs.ReadKey, byPath["/orders?token=[redacted]"]},
	} {
		if code := get(c.key, "/api/v1/requests/"+c.id, nil); code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", name, code)
		}
	}
}
