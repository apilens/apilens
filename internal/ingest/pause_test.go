package ingest

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/platform/config"
)

// pausedVerifier accepts testKey as a key of a project whose ingest is
// paused.
type pausedVerifier struct{}

func (pausedVerifier) Verify(_ context.Context, raw string) (apikeys.Principal, error) {
	if raw != testKey {
		return apikeys.Principal{}, apikeys.ErrInvalidKey
	}
	return apikeys.Principal{KeyID: testKeyID, ProjectID: testProject, ProjectSlug: "shop", Scopes: []string{"ingest"}, ProjectPaused: true}, nil
}

// Every ingest route answers 403 project_paused for a paused project's key,
// stores nothing and counts the call under
// apilens_ingest_rejected_total{reason="project_paused"}.
func TestPausedProjectIsRefusedOnEveryRoute(t *testing.T) {
	reg := prometheus.NewRegistry()
	sink := &fakeSink{}
	e := New(pausedVerifier{}, fakeApps{}, sink, config.IngestConfig{MaxBodyBytes: 64 << 10, MaxRecordsPerRequest: 1000},
		slog.New(slog.NewTextHandler(io.Discard, nil)), reg).
		WithMetadata(&fakeMetadata{}).WithHeartbeat(&fakeHeartbeats{}, nil)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)

	routes := map[string]string{
		"/v1/requests":    validRequest,
		"/v1/logs":        `{"logs":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","message":"m"}]}`,
		"/v1/traces":      `{"spans":[{"app_id":"storefront","timestamp":"2026-10-22T11:00:00Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7"}]}`,
		"/v1/deploys":     `{"deploys":[{"release":"v1"}]}`,
		"/v1/metadata":    validMetadata,
		"/v1/heartbeat":   validHeartbeat,
		"/otlp/v1/traces": `{}`,
		"/otlp/v1/logs":   `{}`,
	}
	for path, body := range routes {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", testKey)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: code = %d, want 403 (%s)", path, rec.Code, rec.Body)
		}
		var got struct {
			Error   string `json:"error"`   // v1 routes
			Message string `json:"message"` // OTLP routes answer a google.rpc.Status
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: body %s: %v", path, rec.Body, err)
		}
		if strings.HasPrefix(path, "/otlp/") {
			if !strings.Contains(got.Message, "paused") {
				t.Fatalf("%s: body %s, want a paused message", path, rec.Body)
			}
		} else if got.Error != CodeProjectPaused {
			t.Fatalf("%s: body %s, want error %q", path, rec.Body, CodeProjectPaused)
		}
		if rec.Header().Get("Retry-After") != "" {
			t.Fatalf("%s: a paused project's 403 carries Retry-After", path)
		}
	}
	if n := testutil.ToFloat64(e.rejected.WithLabelValues(CodeProjectPaused)); n != float64(len(routes)) {
		t.Fatalf("rejected{reason=project_paused} = %v, want %d", n, len(routes))
	}
	if len(sink.requests) != 0 || len(sink.logs) != 0 || len(sink.spans) != 0 || len(sink.deploys) != 0 {
		t.Fatalf("a paused project's records were stored: %+v", sink)
	}
	// Unknown keys stay 401, not project_paused.
	req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(validRequest))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", "apl_live_unknown")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key: code = %d, want 401", rec.Code)
	}
}
