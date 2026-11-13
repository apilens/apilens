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
	"reflect"
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
	testKeyID   = uuid.MustParse("44444444-4444-4444-8444-444444444444")
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
	return apikeys.Principal{KeyID: testKeyID, ProjectID: testProject, ProjectSlug: "shop", Scopes: []string{"ingest"}}, nil
}

type fakeApps struct{}

func (fakeApps) ResolveFor(_ context.Context, _ uuid.UUID, c catalog.Caller, idents []string) (catalog.Result, error) {
	return staticResolve(c, idents, map[string]uuid.UUID{"": testApp, "storefront": testApp, testApp.String(): testApp})
}

// staticResolve resolves idents against known like the catalog does for a
// key that cannot create apps: the rest is rejected (app_create_forbidden).
func staticResolve(c catalog.Caller, idents []string, known map[string]uuid.UUID) (catalog.Result, error) {
	res := catalog.Result{Apps: map[string]uuid.UUID{}, Rejected: map[string]catalog.Rejection{}}
	for _, id := range idents {
		if app, ok := known[id]; ok {
			res.Apps[id] = app
			continue
		}
		if c.LookupOnly {
			res.Rejected[id] = catalog.Rejection{Slug: id, Reason: catalog.ReasonUnknown, Message: "unknown app " + id}
			continue
		}
		res.Rejected[id] = catalog.Rejection{Slug: id, Reason: catalog.ReasonCreateForbidden,
			Message: "app \"" + id + "\" does not exist in project shop and this API key cannot create apps"}
	}
	return res, nil
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
	// Compat: an old SDK payload (no M3 fields) is sampled, with no
	// attributes or validation errors.
	if !row.Sampled || row.Attributes != nil || row.ValidationErrors != nil {
		t.Errorf("old SDK payload defaults wrong: sampled=%v attrs=%v errors=%v", row.Sampled, row.Attributes, row.ValidationErrors)
	}
}

func TestRequestsNewSDKFields(t *testing.T) {
	sink := &fakeSink{}
	body := strings.Replace(validRequest, `"release":"v1.2.3"`, `"release":"v1.2.3","sampled":false,
 "attributes":{"tenant.id":"acme","plan":3,"nested":{"x":1}},
 "validation_errors":[{"loc":["body","email"],"msg":"field required","type":"missing"}],"unknown_future_field":1`, 1)
	rec := post(t, newEdge(t, fakeVerifier{}, sink), "/v1/requests", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := sink.requests[0]
	if row.Sampled {
		t.Error("sampled=false not honoured")
	}
	if want := map[string]string{"tenant.id": "acme", "plan": "3"}; !reflect.DeepEqual(row.Attributes, want) {
		t.Errorf("attributes = %v, want %v", row.Attributes, want)
	}
	if want := []pipeline.ValidationError{{Loc: "body.email", Msg: "field required", Type: "missing"}}; !reflect.DeepEqual(row.ValidationErrors, want) {
		t.Errorf("validation_errors = %+v, want %+v", row.ValidationErrors, want)
	}

	// A malformed validation_errors value is dropped, not a 422.
	sink = &fakeSink{}
	body = strings.Replace(validRequest, `"release":"v1.2.3"`, `"release":"v1.2.3","validation_errors":"oops"`, 1)
	if rec := post(t, newEdge(t, fakeVerifier{}, sink), "/v1/requests", body, nil); rec.Code != http.StatusOK || sink.requests[0].ValidationErrors != nil {
		t.Fatalf("malformed validation_errors: %d %s %+v", rec.Code, rec.Body, sink.requests)
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
		"deleted proj":   {path: "/v1/requests", body: validRequest, verifier: fakeVerifier{err: apikeys.ErrProjectDeleted}, code: 403, contains: "project_deleted"},
		"slug mismatch":  {path: "/v1/requests", body: strings.Replace(validRequest, `"shop"`, `"other"`, 1), code: 422, contains: "project_slug"},
		"unknown app":    {path: "/v1/requests", body: strings.Replace(validRequest, `"storefront"`, `"ghost"`, 1), code: 403, contains: "cannot create apps"},
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

// scopedVerifier accepts testKey with the given scopes only.
type scopedVerifier struct{ scopes []string }

func (v scopedVerifier) Verify(_ context.Context, raw string) (apikeys.Principal, error) {
	if raw != testKey {
		return apikeys.Principal{}, apikeys.ErrInvalidKey
	}
	return apikeys.Principal{ProjectID: testProject, ProjectSlug: "shop", Scopes: v.scopes}, nil
}

// newFullEdge wires every optional store, so each route reaches its own
// validation instead of answering 503.
func newFullEdge(t *testing.T, v Verifier, maxBody int64) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: maxBody, MaxRecordsPerRequest: 1000}
	e := New(v, fakeApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil).
		WithMetadata(&fakeMetadata{}).WithHeartbeat(&fakeHeartbeats{}, nil)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

// TestEveryRouteGuards checks the guards every ingest route shares (auth,
// scope, method, media type, encoding, body limit), so a new handler cannot
// skip one.
func TestEveryRouteGuards(t *testing.T) {
	routes := map[string]struct {
		body string
		json bool // v1 JSON only; the OTLP routes also take protobuf
	}{
		"/v1/requests":    {validRequest, true},
		"/v1/logs":        {`{"logs":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","message":"m"}]}`, true},
		"/v1/traces":      {`{"spans":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}]}`, true},
		"/v1/deploys":     {`{"deploys":[{"release":"v1"}]}`, true},
		"/v1/metadata":    {validMetadata, true},
		"/v1/heartbeat":   {validHeartbeat, true},
		"/otlp/v1/traces": {`{}`, false},
		"/otlp/v1/logs":   {`{}`, false},
	}
	cases := map[string]struct {
		verifier Verifier
		method   string
		headers  map[string]string
		bigBody  bool
		jsonOnly bool
		code     int
	}{
		"accepted":       {code: http.StatusOK},
		"no key":         {headers: map[string]string{"X-API-Key": ""}, code: http.StatusUnauthorized},
		"unknown key":    {headers: map[string]string{"X-API-Key": "apl_live_unknown"}, code: http.StatusUnauthorized},
		"bearer key":     {headers: map[string]string{"X-API-Key": "", "Authorization": "Bearer " + testKey}, code: http.StatusOK},
		"read-only key":  {verifier: scopedVerifier{[]string{"read"}}, code: http.StatusForbidden},
		"auth backend":   {verifier: fakeVerifier{err: errors.New("db down")}, code: http.StatusServiceUnavailable},
		"GET":            {method: http.MethodGet, code: http.StatusMethodNotAllowed},
		"unknown codec":  {headers: map[string]string{"Content-Encoding": "br"}, code: http.StatusUnsupportedMediaType},
		"bad gzip":       {headers: map[string]string{"Content-Encoding": "gzip"}, code: http.StatusBadRequest},
		"body too large": {bigBody: true, code: http.StatusRequestEntityTooLarge},
		"text/plain":     {headers: map[string]string{"Content-Type": "text/plain"}, jsonOnly: true, code: http.StatusUnsupportedMediaType},
	}
	const limit = 64 << 10
	for path, route := range routes {
		for name, tc := range cases {
			if tc.jsonOnly && !route.json {
				continue
			}
			t.Run(path+"/"+name, func(t *testing.T) {
				v := tc.verifier
				if v == nil {
					v = fakeVerifier{}
				}
				body := route.body
				if tc.bigBody {
					body = `{"x":"` + strings.Repeat("a", limit) + `"}`
				}
				method := tc.method
				if method == "" {
					method = http.MethodPost
				}
				req := httptest.NewRequest(method, path, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-API-Key", testKey)
				for k, val := range tc.headers {
					if val == "" {
						req.Header.Del(k)
					} else {
						req.Header.Set(k, val)
					}
				}
				rec := httptest.NewRecorder()
				newFullEdge(t, v, limit).ServeHTTP(rec, req)
				if rec.Code != tc.code {
					t.Fatalf("code = %d, want %d (%s)", rec.Code, tc.code, rec.Body)
				}
				if tc.code == http.StatusServiceUnavailable && rec.Header().Get("Retry-After") == "" {
					t.Fatal("503 without Retry-After")
				}
			})
		}
	}
}

func TestAPIErrorString(t *testing.T) {
	if got := errValidation("bad %s", "x").Error(); got != "422 validation_error: bad x" {
		t.Fatalf("Error() = %q", got)
	}
}
