//go:build integration

package ingest_test

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

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

type discardSink struct{}

func (discardSink) SubmitRequests(context.Context, []pipeline.RequestRow) error { return nil }
func (discardSink) SubmitLogs(context.Context, []pipeline.LogRow) error         { return nil }
func (discardSink) SubmitSpans(context.Context, []pipeline.SpanRow) error       { return nil }
func (discardSink) SubmitDeploys(context.Context, []pipeline.DeployRow) error   { return nil }

// TestHeartbeatThenAppStatus runs the whole path against real Postgres and
// Valkey: an SDK heartbeat is stored, rate-limited per instance, mirrored to
// the last-seen key, answered with the app's capture policy, and
// GET /api/v1/apps/{id}/status then shows the app reporting.
func TestHeartbeatThenAppStatus(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO capture_policies (app_id, enabled, sample_rate, capture_headers,
		capture_request_body, capture_response_body, max_payload_bytes) VALUES ($1, false, 0.5, true, false, true, 2048)`, seed.AppID); err != nil {
		t.Fatal(err)
	}

	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 10, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	ingest.New(verifier, catalog.NewAppResolver(q, time.Minute), discardSink{}, cfg, logger, nil).
		WithCapture(capture.NewResolver(q, time.Minute)).
		WithHeartbeat(q, ingest.NewValkeyHeartbeats(vk)).
		Register(srv.Mux())
	api := srv.API()
	api.UseMiddleware(query.AuthMiddleware(api, verifier, nil))
	query.Register(api, query.NewService(nil, q), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	heartbeat := func(instance string) (int, string) {
		t.Helper()
		body := `{"app_id":"storefront","instance_id":"` + instance + `","sdk_name":"apilenss","sdk_version":"0.5.0",
			"runtime":"python 3.13.1","release":"r1","commit":"abc","pid":7,"stats":{"sent":5}}`
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/v1/heartbeat", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", seed.APIKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	status := func(key string) (int, query.AppStatus) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/apps/"+seed.AppID.String()+"/status", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out query.AppStatus
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode, out
	}

	if code, s := status(seed.ReadKey); code != http.StatusOK || s.Status != query.StatusNever || s.LastSeenAt != nil {
		t.Fatalf("before heartbeat = %d %+v", code, s)
	}

	code, body := heartbeat("inst-1")
	if code != http.StatusOK {
		t.Fatalf("heartbeat = %d %s", code, body)
	}
	want := `{"policy":{"enabled":false,"sample_rate":0.5,"capture_headers":true,"capture_request_body":false,"capture_response_body":true,"max_payload_bytes":2048}}`
	if strings.TrimSpace(body) != want {
		t.Errorf("heartbeat body = %s, want %s", body, want)
	}
	if code, body := heartbeat("inst-1"); code != http.StatusTooManyRequests {
		t.Errorf("second heartbeat within 10s = %d %s, want 429", code, body)
	}
	if code, body := heartbeat("inst-2"); code != http.StatusOK {
		t.Errorf("other instance = %d %s", code, body)
	}

	key := ingest.LastSeenKeyPrefix + seed.AppID.String() + ":production"
	ttl, err := vk.Do(ctx, vk.B().Ttl().Key(key).Build()).AsInt64()
	if err != nil || ttl <= 0 || ttl > int64(ingest.LastSeenTTL/time.Second) {
		t.Errorf("last-seen key ttl = %d, %v", ttl, err)
	}

	code, s := status(seed.ReadKey)
	if code != http.StatusOK || s.Status != query.StatusReporting || s.LastSeenAt == nil || s.App != "storefront" {
		t.Fatalf("after heartbeat = %d %+v", code, s)
	}
	if len(s.Environments) != 1 || s.Environments[0].Environment != "production" || s.Environments[0].Status != query.StatusReporting ||
		s.Environments[0].LiveInstances != 2 {
		t.Errorf("environments = %+v", s.Environments)
	}
	if len(s.Instances) != 2 {
		t.Fatalf("instances = %+v", s.Instances)
	}
	for _, in := range s.Instances {
		if in.SDKName != "apilenss" || in.SDKVersion != "0.5.0" || in.Runtime != "python 3.13.1" || in.Release != "r1" ||
			in.Commit != "abc" || in.PID == nil || *in.PID != 7 || in.Stats["sent"] != float64(5) || in.Status != query.StatusReporting {
			t.Errorf("instance = %+v", in)
		}
	}

	// Another project's read key cannot see the app.
	if code, _ := status(other.ReadKey); code != http.StatusNotFound {
		t.Errorf("other project's read key = %d, want 404", code)
	}

	// Ten minutes without a heartbeat: stale.
	if _, err := pool.Exec(ctx, `UPDATE app_instances SET last_seen_at = now() - interval '10 minutes' WHERE app_id = $1`, seed.AppID); err != nil {
		t.Fatal(err)
	}
	if code, s := status(seed.ReadKey); code != http.StatusOK || s.Status != query.StatusStale || s.Environments[0].LiveInstances != 0 {
		t.Errorf("stale = %d %+v", code, s)
	}
}
