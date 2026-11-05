//go:build e2e

// Package e2e drives a running APILens (docker compose, -target=all) from the
// outside, the way SDKs and OpenTelemetry exporters do, and checks the rows
// that land in ClickHouse.
//
//	APILENS_E2E_BASE_URL=http://localhost:8080
//	APILENS_E2E_API_KEY=apl_live_...   (from `apilens seed`: api_key)
//	APILENS_E2E_READ_KEY=apl_live_...  (from `apilens seed`: read_key, optional)
//	APILENS_E2E_APP=default            (app slug from seed)
//	APILENS_E2E_CLICKHOUSE_HTTP=http://localhost:8123
//	APILENS_E2E_CLICKHOUSE_USER / APILENS_E2E_CLICKHOUSE_PASSWORD
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"
)

type env struct {
	base, key, app, chURL, chUser, chPass string
}

func loadEnv(t *testing.T) env {
	t.Helper()
	e := env{
		base: os.Getenv("APILENS_E2E_BASE_URL"), key: os.Getenv("APILENS_E2E_API_KEY"), app: os.Getenv("APILENS_E2E_APP"),
		chURL: os.Getenv("APILENS_E2E_CLICKHOUSE_HTTP"), chUser: os.Getenv("APILENS_E2E_CLICKHOUSE_USER"),
		chPass: os.Getenv("APILENS_E2E_CLICKHOUSE_PASSWORD"),
	}
	if e.base == "" || e.key == "" || e.app == "" || e.chURL == "" {
		t.Skip("APILENS_E2E_* not set; run via `task test:e2e` against a running stack")
	}
	if e.chUser == "" {
		e.chUser = "apilens"
	}
	return e
}

func (e env) post(t *testing.T, path, key string, body any) (int, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, e.base+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// count runs a ClickHouse query over the HTTP interface and returns the
// first column of the first row as an integer.
func (e env) count(t *testing.T, query string) int {
	t.Helper()
	u := e.chURL + "/?database=apilens&query=" + url.QueryEscape(query+" FORMAT TabSeparated")
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
	req.SetBasicAuth(e.chUser, e.chPass)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("clickhouse: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clickhouse %d: %s", resp.StatusCode, body)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(body)))
	if err != nil {
		t.Fatalf("clickhouse returned %q", body)
	}
	return n
}

func (e env) eventually(t *testing.T, what, query string, want int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		got := e.count(t, query)
		if got >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: got %d rows, want >= %d (query: %s)", what, got, want, query)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func TestIngestEndToEnd(t *testing.T) {
	e := loadEnv(t)
	run := fmt.Sprintf("e2e%d", time.Now().UnixNano())
	now := time.Now().UTC()

	// 1. v1 SDK wire format.
	var reqs []map[string]any
	for i := range 3 {
		reqs = append(reqs, map[string]any{
			"app_id": e.app, "timestamp": now.Add(time.Duration(-i) * time.Second).Format(time.RFC3339Nano),
			"environment": "e2e", "method": "GET", "path": "/" + run + "/{id}", "raw_path": "/" + run + "/" + strconv.Itoa(i),
			"status_code": []int{200, 404, 500}[i], "response_time_ms": 10 + i,
		})
	}
	if code, body := e.post(t, "/v1/requests", e.key, map[string]any{"requests": reqs}); code != 200 || !strings.Contains(body, `"accepted":3`) {
		t.Fatalf("/v1/requests = %d %s", code, body)
	}
	// M3 SDK fields: sampled, attributes, validation_errors.
	if code, body := e.post(t, "/v1/requests", e.key, map[string]any{"requests": []map[string]any{{
		"app_id": e.app, "timestamp": now.Format(time.RFC3339Nano), "environment": "e2e", "method": "POST",
		"path": "/" + run + "/m3", "status_code": 422, "response_time_ms": 4, "sampled": false,
		"attributes":        map[string]any{"tenant.id": run},
		"validation_errors": []map[string]any{{"loc": []any{"body", "email"}, "msg": "field required", "type": "missing"}},
	}}}); code != 200 {
		t.Fatalf("/v1/requests (m3 fields) = %d %s", code, body)
	}
	if code, body := e.post(t, "/v1/logs", e.key, map[string]any{"logs": []map[string]any{{
		"app_id": e.app, "timestamp": now.Format(time.RFC3339Nano), "environment": "e2e", "level": "error", "message": run + " legacy log",
	}}}); code != 200 {
		t.Fatalf("/v1/logs = %d %s", code, body)
	}
	if code, body := e.post(t, "/v1/traces", e.key, map[string]any{"spans": []map[string]any{{
		"app_id": e.app, "timestamp": now.Format(time.RFC3339Nano), "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
		"span_id": "00f067aa0ba902b7", "name": run + " legacy span", "kind": "server", "duration_ms": 3,
	}}}); code != 200 {
		t.Fatalf("/v1/traces = %d %s", code, body)
	}
	if code, body := e.post(t, "/v1/deploys", e.key, map[string]any{"deploys": []map[string]any{{"release": run, "environment": "e2e"}}}); code != 200 {
		t.Fatalf("/v1/deploys = %d %s", code, body)
	}

	// 2. Auth is enforced.
	if code, _ := e.post(t, "/v1/requests", "apl_live_not-a-real-key-not-a-real-key-00000", map[string]any{"requests": reqs}); code != 401 {
		t.Fatalf("bad key = %d, want 401", code)
	}

	// 3. A real OpenTelemetry SDK exporting OTLP/HTTP protobuf to /otlp.
	exp, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpointURL(e.base+"/otlp/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{"X-API-Key": e.key}),
	)
	if err != nil {
		t.Fatal(err)
	}
	res, _ := resource.New(context.Background(), resource.WithAttributes(
		attribute.String("service.name", e.app), attribute.String("deployment.environment.name", "e2e")))
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp), sdktrace.WithResource(res))
	_, span := tp.Tracer("e2e").Start(context.Background(), run+" otlp span")
	span.SetAttributes(attribute.Int("http.response.status_code", 201))
	span.End()
	if err := tp.Shutdown(context.Background()); err != nil {
		t.Fatalf("otlp export: %v", err)
	}

	// 4. OTLP logs (protobuf, hand-built: the Go logs SDK is not needed here).
	logsReq := &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{Key: "service.name", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: e.app}}}}},
		ScopeLogs: []*logspb.ScopeLogs{{LogRecords: []*logspb.LogRecord{{
			TimeUnixNano: uint64(now.UnixNano()), SeverityText: "WARN",
			Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: run + " otlp log"}},
		}}}},
	}}}
	b, _ := proto.Marshal(logsReq)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, e.base+"/otlp/v1/logs", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Authorization", "Bearer "+e.key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/otlp/v1/logs = %d", resp.StatusCode)
	}

	// 5. Everything is queryable, including the rollup.
	e.eventually(t, "requests", fmt.Sprintf("SELECT count() FROM api_requests WHERE path = '/%s/{id}'", run), 3)
	e.eventually(t, "1m rollup", fmt.Sprintf("SELECT sum(requests) FROM api_requests_1m WHERE path = '/%s/{id}'", run), 3)
	e.eventually(t, "server errors", fmt.Sprintf("SELECT sum(server_errors) FROM api_requests_1m WHERE path = '/%s/{id}'", run), 1)
	e.eventually(t, "m3 request fields", fmt.Sprintf(`SELECT count() FROM api_requests WHERE path = '/%s/m3'
		AND sampled = 0 AND attributes['tenant.id'] = '%s'
		AND JSONExtractString(validation_errors, 1, 'loc') = 'body.email'
		AND JSONExtractString(validation_errors, 1, 'type') = 'missing'`, run, run), 1)
	e.eventually(t, "old requests default to sampled", fmt.Sprintf("SELECT count() FROM api_requests WHERE path = '/%s/{id}' AND sampled = 1", run), 3)
	e.eventually(t, "logs", fmt.Sprintf("SELECT count() FROM api_logs WHERE message LIKE '%s %%'", run), 2)
	e.eventually(t, "spans", fmt.Sprintf("SELECT count() FROM api_spans WHERE name LIKE '%s %%'", run), 2)
	e.eventually(t, "otlp span status", fmt.Sprintf("SELECT count() FROM api_spans WHERE name = '%s otlp span' AND status_code = 201 AND environment = 'e2e'", run), 1)
	e.eventually(t, "deploys", fmt.Sprintf("SELECT count() FROM api_deploys WHERE release = '%s'", run), 1)

	// 6. The dashboard API serves the same data with a read key.
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Log("APILENS_E2E_READ_KEY not set; skipping query API checks")
		return
	}
	var endpoints struct {
		Endpoints []struct {
			Path     string `json:"path"`
			Requests int    `json:"requests"`
		} `json:"endpoints"`
	}
	e.getJSON(t, readKey, "/api/v1/traffic/endpoints?range=1h&env=e2e", &endpoints)
	found := false
	for _, ep := range endpoints.Endpoints {
		if ep.Path == "/"+run+"/{id}" && ep.Requests == 3 {
			found = true
		}
	}
	if !found {
		t.Fatalf("query API endpoints missing /%s/{id} with 3 requests: %+v", run, endpoints)
	}
	if code := e.status(t, e.key, "/api/v1/traffic/summary"); code != http.StatusForbidden {
		t.Fatalf("ingest key on the query API = %d, want 403", code)
	}
}

// TestIngestMaskingAndCaps sends a request record and a log whose SDK masked
// nothing and a response body over the server-side cap, and checks the rows
// ClickHouse holds: secrets replaced, other values kept, the body cut with
// the marker. The per-app ingest health counters count both.
func TestIngestMaskingAndCaps(t *testing.T) {
	e := loadEnv(t)
	run := fmt.Sprintf("e2emask%d", time.Now().UnixNano())
	now := time.Now().UTC().Format(time.RFC3339Nano)
	// Above the default 64 KiB payload cap, below the body limit.
	big := `{"data":"` + strings.Repeat("x", 100<<10) + `"}`

	if code, body := e.post(t, "/v1/requests", e.key, map[string]any{"requests": []map[string]any{{
		"app_id": e.app, "timestamp": now, "environment": "e2e", "method": "POST", "path": "/" + run + "/login",
		"raw_path":         "/" + run + "/login?next=%2Fhome&access_token=abc123",
		"status_code":      200,
		"response_time_ms": 5,
		"request_headers":  `{"authorization":"Bearer sk_live_e2esecret","x-tenant":"acme"}`,
		"request_payload":  `{"email":"ada@example.com","password":"hunter2"}`,
		"response_payload": big,
	}}}); code != 200 {
		t.Fatalf("/v1/requests = %d %s", code, body)
	}
	if code, body := e.post(t, "/v1/logs", e.key, map[string]any{"logs": []map[string]any{{
		"app_id": e.app, "timestamp": now, "environment": "e2e", "level": "info", "message": run + " login password=hunter2 user=ada",
	}}}); code != 200 {
		t.Fatalf("/v1/logs = %d %s", code, body)
	}

	where := fmt.Sprintf("FROM api_requests WHERE path = '/%s/login'", run)
	e.eventually(t, "masked request", `SELECT count() `+where, 1)
	checks := map[string]string{
		"query parameter masked":  fmt.Sprintf("raw_path = '/%s/login?next=%%2Fhome&access_token=[redacted]'", run),
		"auth header masked":      `position(request_headers, 'sk_live_e2esecret') = 0 AND position(request_headers, '"authorization":"[redacted]"') > 0`,
		"other header kept":       `position(request_headers, '"x-tenant":"acme"') > 0`,
		"body field masked":       `position(request_payload, 'hunter2') = 0 AND position(request_payload, '"password":"[redacted]"') > 0`,
		"other body field kept":   `position(request_payload, '"email":"ada@example.com"') > 0`,
		"response body truncated": `endsWith(response_payload, '…[truncated]') AND length(response_payload) <= 65536 + length('…[truncated]')`,
	}
	for what, cond := range checks {
		if n := e.count(t, `SELECT count() `+where+` AND `+cond); n != 1 {
			t.Errorf("%s: %d rows match %s", what, n, cond)
		}
	}
	e.eventually(t, "log row", fmt.Sprintf("SELECT count() FROM api_logs WHERE message LIKE '%s %%'", run), 1)
	if n := e.count(t, fmt.Sprintf("SELECT count() FROM api_logs WHERE message = '%s login password=[redacted] user=ada'", run)); n != 1 {
		t.Errorf("log message not masked: %d rows", n)
	}

	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Log("APILENS_E2E_READ_KEY not set; skipping ingest-stats checks")
		return
	}
	var stats struct {
		Totals struct {
			Accepted  int64 `json:"accepted"`
			Truncated int64 `json:"truncated"`
			Masked    int64 `json:"masked"`
		} `json:"totals"`
	}
	e.getJSON(t, readKey, "/api/v1/apps/"+e.appID(t, readKey)+"/ingest-stats?days=1", &stats)
	if stats.Totals.Accepted < 2 || stats.Totals.Truncated < 1 || stats.Totals.Masked < 2 {
		t.Fatalf("ingest-stats totals = %+v, want accepted >= 2, truncated >= 1, masked >= 2", stats.Totals)
	}
}

// project returns the read key's project slug and the id of the e2e app.
func (e env) project(t *testing.T, readKey string) (slug, appID string) {
	t.Helper()
	var project struct {
		Project struct {
			Slug string `json:"slug"`
		} `json:"project"`
		Apps []struct {
			ID   string `json:"id"`
			Slug string `json:"slug"`
		} `json:"apps"`
	}
	e.getJSON(t, readKey, "/api/v1/project", &project)
	for _, a := range project.Apps {
		if a.Slug == e.app || a.ID == e.app {
			return project.Project.Slug, a.ID
		}
	}
	t.Fatalf("app %q not in /api/v1/project: %+v", e.app, project)
	return "", ""
}

func (e env) appID(t *testing.T, readKey string) string {
	t.Helper()
	_, id := e.project(t, readKey)
	return id
}

func (e env) status(t *testing.T, key, path string) int {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, e.base+path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func (e env) getJSON(t *testing.T, key, path string, out any) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, e.base+path, nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s = %d %s", path, resp.StatusCode, b)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}
