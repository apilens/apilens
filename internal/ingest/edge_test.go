package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/zstd"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/config"
)

const testKey = "apl_live_TESTKEYTESTKEYTESTKEYTESTKEYTESTKEYTESTKEY"

var (
	testProject = uuid.MustParse("11111111-1111-4111-8111-111111111111")
	testApp     = uuid.MustParse("22222222-2222-4222-8222-222222222222")
	fixedNow    = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
)

type fakeVerifier struct{ err error }

func (f fakeVerifier) Verify(_ context.Context, raw string) (apikeys.Principal, error) {
	if f.err != nil {
		return apikeys.Principal{}, f.err
	}
	if raw != testKey {
		return apikeys.Principal{}, apikeys.ErrInvalidKey
	}
	return apikeys.Principal{ProjectID: testProject, ProjectSlug: "shop", Scopes: []string{"ingest"}}, nil
}

type fakeApps struct{}

func (fakeApps) Resolve(_ context.Context, _ uuid.UUID, idents []string) (map[string]uuid.UUID, error) {
	out := map[string]uuid.UUID{}
	var unknown []string
	for _, id := range idents {
		if id == "storefront" || id == testApp.String() {
			out[id] = testApp
		} else {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) > 0 {
		return nil, &catalog.UnknownAppsError{Identifiers: unknown}
	}
	return out, nil
}

type fakeSink struct {
	mu       sync.Mutex
	err      error
	requests []pipeline.RequestRow
	logs     []pipeline.LogRow
	spans    []pipeline.SpanRow
	deploys  []pipeline.DeployRow
}

func (s *fakeSink) SubmitRequests(_ context.Context, rows []pipeline.RequestRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.requests = append(s.requests, rows...)
	return nil
}

func (s *fakeSink) SubmitLogs(_ context.Context, rows []pipeline.LogRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.logs = append(s.logs, rows...)
	return nil
}

func (s *fakeSink) SubmitSpans(_ context.Context, rows []pipeline.SpanRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.spans = append(s.spans, rows...)
	return nil
}

func (s *fakeSink) SubmitDeploys(_ context.Context, rows []pipeline.DeployRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.deploys = append(s.deploys, rows...)
	return nil
}

func newEdge(t *testing.T, v Verifier, sink *fakeSink) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(v, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

func post(t *testing.T, h http.Handler, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", testKey)
	for k, v := range headers {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const validRequest = `{"requests":[{"project_slug":"shop","app_id":"storefront","timestamp":"2026-10-22T11:59:00.123456+00:00",
 "environment":"","method":"get","path":"/orders/{id}","raw_path":"/orders/42?x=1","status_code":503,"response_time_ms":12.5,
 "request_size":10,"response_size":-5,"consumer_id":" user-1 ","trace_id":"4BF92F3577B34DA6A3CE929D0E0E4736","span_id":"00f067aa0ba902b7",
 "release":"v1.2.3"}]}`

func TestLegacyRequestsHappyPath(t *testing.T) {
	sink := &fakeSink{}
	rec := post(t, newEdge(t, fakeVerifier{}, sink), "/v1/requests", validRequest, nil)
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := sink.requests[0]
	if row.ProjectID != testProject || row.AppID != testApp {
		t.Errorf("ids not resolved: %+v", row)
	}
	if row.Method != http.MethodGet || row.Environment != "production" || row.ResponseSize != 0 || row.ConsumerID != "user-1" {
		t.Errorf("normalisation wrong: %+v", row)
	}
	if row.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || row.SpanID != "00f067aa0ba902b7" {
		t.Errorf("trace ids wrong: %q %q", row.TraceID, row.SpanID)
	}
	if !row.Timestamp.Equal(time.Date(2026, 10, 22, 11, 59, 0, 123456000, time.UTC)) {
		t.Errorf("timestamp = %v", row.Timestamp)
	}
}

func TestLegacyErrors(t *testing.T) {
	cases := map[string]struct {
		path, body string
		headers    map[string]string
		verifier   Verifier
		sinkErr    error
		code       int
		contains   string
	}{
		"no key":         {path: "/v1/requests", body: validRequest, headers: map[string]string{"X-API-Key": ""}, code: 401},
		"bad key":        {path: "/v1/requests", body: validRequest, headers: map[string]string{"X-API-Key": "apl_live_nope_nope_nope_nope"}, code: 401},
		"bearer ok":      {path: "/v1/requests", body: validRequest, headers: map[string]string{"X-API-Key": "", "Authorization": "Bearer " + testKey}, code: 200},
		"auth backend":   {path: "/v1/requests", body: validRequest, verifier: fakeVerifier{err: errors.New("db down")}, code: 503},
		"slug mismatch":  {path: "/v1/requests", body: strings.Replace(validRequest, `"shop"`, `"other"`, 1), code: 422, contains: "project_slug"},
		"unknown app":    {path: "/v1/requests", body: strings.Replace(validRequest, `"storefront"`, `"ghost"`, 1), code: 422, contains: "ghost"},
		"missing app":    {path: "/v1/requests", body: strings.Replace(validRequest, `"storefront"`, `""`, 1), code: 422, contains: "app_id"},
		"bad timestamp":  {path: "/v1/requests", body: strings.Replace(validRequest, "2026-10-22T11:59:00.123456+00:00", "yesterday", 1), code: 422},
		"future ts":      {path: "/v1/requests", body: strings.Replace(validRequest, "2026-10-22T11:59", "2027-10-22T11:59", 1), code: 422},
		"empty batch":    {path: "/v1/requests", body: `{"requests":[]}`, code: 422},
		"invalid json":   {path: "/v1/requests", body: `{"requests":`, code: 422},
		"wrong type":     {path: "/v1/requests", body: validRequest, headers: map[string]string{"Content-Type": "text/plain"}, code: 415},
		"bad encoding":   {path: "/v1/requests", body: validRequest, headers: map[string]string{"Content-Encoding": "br"}, code: 415},
		"overloaded":     {path: "/v1/requests", body: validRequest, sinkErr: pipeline.ErrOverloaded, code: 503, contains: "overloaded"},
		"insert failure": {path: "/v1/requests", body: validRequest, sinkErr: errors.New("clickhouse down"), code: 503},
		"span bad ids":   {path: "/v1/traces", body: `{"spans":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","trace_id":"xyz","span_id":"00f067aa0ba902b7"}]}`, code: 422},
		"deploy no rel":  {path: "/v1/deploys", body: `{"deploys":[{"release":""}]}`, code: 422},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			v := tc.verifier
			if v == nil {
				v = fakeVerifier{}
			}
			rec := post(t, newEdge(t, v, &fakeSink{err: tc.sinkErr}), tc.path, tc.body, tc.headers)
			if rec.Code != tc.code {
				t.Fatalf("code = %d, want %d (%s)", rec.Code, tc.code, rec.Body)
			}
			if tc.contains != "" && !strings.Contains(rec.Body.String(), tc.contains) {
				t.Fatalf("body %q does not mention %q", rec.Body, tc.contains)
			}
			if tc.code == 503 && rec.Header().Get("Retry-After") == "" {
				t.Fatal("503 without Retry-After")
			}
			if tc.code >= 400 {
				var body map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == nil {
					t.Fatalf("error body not v1-compatible: %s", rec.Body)
				}
			}
		})
	}
}

func TestLegacyTooManyRecordsAndBodyLimit(t *testing.T) {
	recs := make([]string, 1001)
	for i := range recs {
		recs[i] = `{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","method":"GET","path":"/"}`
	}
	rec := post(t, newEdge(t, fakeVerifier{}, &fakeSink{}), "/v1/requests", `{"requests":[`+strings.Join(recs, ",")+`]}`, nil)
	if rec.Code != 422 || !strings.Contains(rec.Body.String(), "at most 1000") {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}

	huge := `{"requests":[{"request_payload":"` + strings.Repeat("x", 2<<20) + `"}]}`
	rec = post(t, newEdge(t, fakeVerifier{}, &fakeSink{}), "/v1/requests", huge, nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestCompressedBodies(t *testing.T) {
	var gz bytes.Buffer
	gw := gzip.NewWriter(&gz)
	_, _ = gw.Write([]byte(validRequest))
	_ = gw.Close()

	enc, _ := zstd.NewWriter(nil)
	zs := enc.EncodeAll([]byte(validRequest), nil)

	for name, body := range map[string]struct {
		data []byte
		enc  string
	}{"gzip": {gz.Bytes(), "gzip"}, "zstd": {zs, "zstd"}} {
		t.Run(name, func(t *testing.T) {
			sink := &fakeSink{}
			req := httptest.NewRequest(http.MethodPost, "/v1/requests", bytes.NewReader(body.data))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Content-Encoding", body.enc)
			req.Header.Set("X-API-Key", testKey)
			rec := httptest.NewRecorder()
			newEdge(t, fakeVerifier{}, sink).ServeHTTP(rec, req)
			if rec.Code != 200 || len(sink.requests) != 1 {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
		})
	}

	// Zip bomb: small on the wire, larger than the limit once decompressed.
	var bomb bytes.Buffer
	bw := gzip.NewWriter(&bomb)
	_, _ = bw.Write([]byte(`{"requests":[{"request_payload":"` + strings.Repeat("a", 4<<20) + `"}]}`))
	_ = bw.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/requests", &bomb)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-API-Key", testKey)
	rec := httptest.NewRecorder()
	newEdge(t, fakeVerifier{}, &fakeSink{}).ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("zip bomb: got %d", rec.Code)
	}
}

func TestLegacyLogsSpansDeploys(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)

	logs := `{"logs":[{"app_id":"storefront","timestamp":"2026-10-22 11:00:00","environment":"staging","level":"warn",
	  "message":"slow","attributes":{"k":"v","n":3,"nested":{"a":1},"":"x"}}]}`
	if rec := post(t, h, "/v1/logs", logs, nil); rec.Code != 200 {
		t.Fatalf("logs: %d %s", rec.Code, rec.Body)
	}
	l := sink.logs[0]
	if l.Level != "WARNING" || l.Environment != "staging" || l.Attributes["k"] != "v" || l.Attributes["n"] != "3" {
		t.Errorf("log row: %+v", l)
	}
	if _, ok := l.Attributes["nested"]; ok {
		t.Error("nested attribute should be dropped like v1")
	}

	spans := `{"spans":[{"app_id":"storefront","timestamp":1792670400.5,"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736",
	  "span_id":"00f067aa0ba902b7","name":"GET /orders","kind":"SERVER","status":"ERROR","duration_ms":3}]}`
	if rec := post(t, h, "/v1/traces", spans, nil); rec.Code != 200 {
		t.Fatalf("spans: %d %s", rec.Code, rec.Body)
	}
	s := sink.spans[0]
	if s.Kind != "server" || s.Status != "error" || s.Timestamp.Unix() != 1792670400 {
		t.Errorf("span row: %+v", s)
	}

	deploys := `{"deploys":[{"release":"v2","commit":"abc"},{"app_id":"storefront","release":"v3","deployed_at":"2026-10-22T10:00:00Z"}]}`
	if rec := post(t, h, "/v1/deploys", deploys, nil); rec.Code != 200 {
		t.Fatalf("deploys: %d %s", rec.Code, rec.Body)
	}
	if sink.deploys[0].AppID != uuid.Nil || sink.deploys[1].AppID != testApp || !sink.deploys[0].DeployedAt.Equal(fixedNow) {
		t.Errorf("deploy rows: %+v", sink.deploys)
	}
}

func TestHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	newEdge(t, fakeVerifier{}, &fakeSink{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "healthy") {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}
