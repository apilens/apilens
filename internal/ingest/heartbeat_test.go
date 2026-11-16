package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/config"
)

type fakeHeartbeats struct {
	mu   sync.Mutex
	err  error
	rows []db.UpsertAppInstanceParams
}

func (f *fakeHeartbeats) UpsertAppInstance(_ context.Context, arg db.UpsertAppInstanceParams) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.rows = append(f.rows, arg)
	return nil
}

type touch struct {
	app uuid.UUID
	env string
	at  time.Time
}

// fakeHeartbeatCache allows the first heartbeat of each key and refuses the
// rest with a fixed wait, like ValkeyHeartbeats inside the interval.
type fakeHeartbeatCache struct {
	allowErr, touchErr error
	seen               map[string]bool
	touches            []touch
}

func (f *fakeHeartbeatCache) Allow(_ context.Context, key string, every time.Duration) (bool, time.Duration, error) {
	if f.allowErr != nil {
		return false, 0, f.allowErr
	}
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	if f.seen[key] {
		return false, every - 2500*time.Millisecond, nil
	}
	f.seen[key] = true
	return true, 0, nil
}

func (f *fakeHeartbeatCache) Touch(_ context.Context, app uuid.UUID, env string, at time.Time) error {
	f.touches = append(f.touches, touch{app, env, at})
	return f.touchErr
}

func newHeartbeatEdge(t *testing.T, store HeartbeatStore, cache HeartbeatCache, src CaptureSource) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	e.now = func() time.Time { return fixedNow }
	if store != nil {
		e.WithHeartbeat(store, cache)
	}
	if src != nil {
		e.WithCapture(src)
	}
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

const validHeartbeat = `{"project_slug":"shop","app_id":"storefront","environment":"staging","instance_id":" inst-1 ",
 "sdk_name":"apilenss","sdk_version":"0.5.0","runtime":"python 3.13.1","release":"2026.11.05","commit":"9f2c1ab",
 "pid":4242,"stats":{"queued":3,"sent":12345678901234567890},"future_field":true}`

func decodeHeartbeat(t *testing.T, body string) HeartbeatAccepted {
	t.Helper()
	var out HeartbeatAccepted
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return out
}

func TestHeartbeatStoresInstanceAndReturnsDefaultPolicy(t *testing.T) {
	store, cache := &fakeHeartbeats{}, &fakeHeartbeatCache{}
	rec := post(t, newHeartbeatEdge(t, store, cache, nil), "/v1/heartbeat", validHeartbeat, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	want := `{"policy":{"enabled":true,"sample_rate":1,"capture_headers":true,"capture_request_body":true,"capture_response_body":true,"max_payload_bytes":null}}`
	if got := strings.TrimSpace(rec.Body.String()); got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
	if len(store.rows) != 1 {
		t.Fatalf("rows = %d", len(store.rows))
	}
	row := store.rows[0]
	if row.AppID != testApp || row.ProjectID != testProject || row.Environment != "staging" || row.InstanceID != "inst-1" {
		t.Errorf("ids wrong: %+v", row)
	}
	if row.SdkName != "apilenss" || row.SdkVersion != "0.5.0" || row.Runtime != "python 3.13.1" || row.Release != "2026.11.05" || row.Commit != "9f2c1ab" {
		t.Errorf("fields wrong: %+v", row)
	}
	if row.Pid == nil || *row.Pid != 4242 || !row.SeenAt.Equal(fixedNow) {
		t.Errorf("pid/seen wrong: %+v", row)
	}
	if string(row.Stats) != `{"queued":3,"sent":12345678901234567890}` {
		t.Errorf("stats = %s", row.Stats)
	}
	if len(cache.touches) != 1 || cache.touches[0] != (touch{testApp, "staging", fixedNow}) {
		t.Errorf("touches = %+v", cache.touches)
	}
}

func TestHeartbeatReturnsStoredPolicy(t *testing.T) {
	limit := 4096
	src := &fakeCapture{byApp: map[uuid.UUID]capture.Policy{testApp: {
		Enabled: false, SampleRate: 0.25, CaptureHeaders: true, MaxPayloadBytes: &limit,
	}}}
	rec := post(t, newHeartbeatEdge(t, &fakeHeartbeats{}, nil, src), "/v1/heartbeat", `{"app_id":"storefront","instance_id":"i"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	got := decodeHeartbeat(t, rec.Body.String()).Policy
	if got.Enabled || got.SampleRate != 0.25 || !got.CaptureHeaders || got.CaptureRequestBody || got.CaptureResponseBody ||
		got.MaxPayloadBytes == nil || *got.MaxPayloadBytes != 4096 {
		t.Errorf("policy = %+v", got)
	}
}

func TestHeartbeatDefaultsEnvironmentAndOptionalFields(t *testing.T) {
	store := &fakeHeartbeats{}
	rec := post(t, newHeartbeatEdge(t, store, nil, nil), "/v1/heartbeat", `{"app_id":"`+testApp.String()+`","instance_id":"i"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := store.rows[0]
	if row.Environment != "production" || row.Pid != nil || string(row.Stats) != "{}" || row.SdkName != "" {
		t.Errorf("row = %+v", row)
	}
}

func TestHeartbeatRateLimitedPerInstance(t *testing.T) {
	store, cache := &fakeHeartbeats{}, &fakeHeartbeatCache{}
	h := newHeartbeatEdge(t, store, cache, nil)
	body := func(instance, env string) string {
		return `{"app_id":"storefront","instance_id":"` + instance + `","environment":"` + env + `"}`
	}
	if rec := post(t, h, "/v1/heartbeat", body("a", "production"), nil); rec.Code != http.StatusOK {
		t.Fatalf("first: %d %s", rec.Code, rec.Body)
	}
	rec := post(t, h, "/v1/heartbeat", body("a", "production"), nil)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "8" || !strings.Contains(rec.Body.String(), `"rate_limited"`) {
		t.Fatalf("second: %d %s Retry-After=%q", rec.Code, rec.Body, rec.Header().Get("Retry-After"))
	}
	// Other instances and environments have their own budget.
	for _, b := range []string{body("b", "production"), body("a", "staging")} {
		if rec := post(t, h, "/v1/heartbeat", b, nil); rec.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", b, rec.Code, rec.Body)
		}
	}
	if len(store.rows) != 3 {
		t.Errorf("rows = %d, want 3 (the limited heartbeat is not stored)", len(store.rows))
	}
}

func TestHeartbeatCacheFailsOpen(t *testing.T) {
	store := &fakeHeartbeats{}
	cache := &fakeHeartbeatCache{allowErr: errors.New("valkey down"), touchErr: errors.New("valkey down")}
	rec := post(t, newHeartbeatEdge(t, store, cache, nil), "/v1/heartbeat", `{"app_id":"storefront","instance_id":"i"}`, nil)
	if rec.Code != http.StatusOK || len(store.rows) != 1 {
		t.Fatalf("got %d %s rows=%d", rec.Code, rec.Body, len(store.rows))
	}
}

func TestHeartbeatRejects(t *testing.T) {
	long := strings.Repeat("x", 129)
	cases := []struct {
		name, body string
		code       int
	}{
		{"unknown app", `{"app_id":"nope","instance_id":"i"}`, http.StatusForbidden},
		{"wrong project", `{"project_slug":"other","app_id":"storefront","instance_id":"i"}`, http.StatusUnprocessableEntity},
		{"missing instance", `{"app_id":"storefront"}`, http.StatusUnprocessableEntity},
		{"blank instance", `{"app_id":"storefront","instance_id":"  "}`, http.StatusUnprocessableEntity},
		{"long instance", `{"app_id":"storefront","instance_id":"` + long + `"}`, http.StatusUnprocessableEntity},
		{"negative pid", `{"app_id":"storefront","instance_id":"i","pid":-1}`, http.StatusUnprocessableEntity},
		{"api key in stats", `{"app_id":"storefront","instance_id":"i","stats":{"nested":{"apiKey":"x"}}}`, http.StatusUnprocessableEntity},
		{"huge stats", `{"app_id":"storefront","instance_id":"i","stats":{"s":"` + strings.Repeat("a", 17<<10) + `"}}`, http.StatusUnprocessableEntity},
		{"not json", `{`, http.StatusUnprocessableEntity},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			store := &fakeHeartbeats{}
			rec := post(t, newHeartbeatEdge(t, store, nil, nil), "/v1/heartbeat", c.body, nil)
			if rec.Code != c.code {
				t.Fatalf("got %d %s, want %d", rec.Code, rec.Body, c.code)
			}
			if len(store.rows) != 0 {
				t.Errorf("stored %d rows", len(store.rows))
			}
		})
	}
}

func TestHeartbeatAuth(t *testing.T) {
	h := newHeartbeatEdge(t, &fakeHeartbeats{}, nil, nil)
	if rec := post(t, h, "/v1/heartbeat", `{"app_id":"storefront","instance_id":"i"}`, map[string]string{"X-API-Key": ""}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no key: %d", rec.Code)
	}
}

func TestHeartbeatUnavailable(t *testing.T) {
	body := `{"app_id":"storefront","instance_id":"i"}`
	if rec := post(t, newHeartbeatEdge(t, nil, nil, nil), "/v1/heartbeat", body, nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("no store: %d %s", rec.Code, rec.Body)
	}
	if rec := post(t, newHeartbeatEdge(t, &fakeHeartbeats{err: errors.New("pg down")}, nil, nil), "/v1/heartbeat", body, nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("store error: %d %s", rec.Code, rec.Body)
	}
	// Answering capture-everything when the policy is unknown could undo a
	// disabled app; the SDK keeps its previous policy on 503.
	src := &fakeCapture{err: errors.New("pg down")}
	rec := post(t, newHeartbeatEdge(t, &fakeHeartbeats{}, nil, src), "/v1/heartbeat", body, nil)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Errorf("policy error: %d %s", rec.Code, rec.Body)
	}
}
