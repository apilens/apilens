package ingest

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/platform/config"
)

// pinnedVerifier accepts testKey as an ingest key pinned to envs.
type pinnedVerifier struct{ envs []string }

func (v pinnedVerifier) Verify(_ context.Context, raw string) (apikeys.Principal, error) {
	if raw != testKey {
		return apikeys.Principal{}, apikeys.ErrInvalidKey
	}
	return apikeys.Principal{KeyID: testKeyID, ProjectID: testProject, ProjectSlug: "shop", Scopes: []string{"ingest"}, Environments: v.envs}, nil
}

func newPinnedEdge(t *testing.T, envs []string, sink *fakeSink, meta *fakeMetadata, hb *fakeHeartbeats) (*Edge, http.Handler) {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(pinnedVerifier{envs}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil).
		WithMetadata(meta).WithHeartbeat(hb, nil)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return e, mux
}

func TestEnvironmentPinnedKeyRejectsPerRecord(t *testing.T) {
	sink := &fakeSink{}
	e, h := newPinnedEdge(t, []string{"staging"}, sink, &fakeMetadata{}, &fakeHeartbeats{})

	body := `{"logs":[
	 {"app_id":"storefront","environment":"staging","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"a"},
	 {"app_id":"storefront","environment":"production","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"b"},
	 {"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"c"},
	 {"app_id":"storefront","environment":" staging ","timestamp":"2026-10-22T11:59:00Z","level":"info","message":"d"}]}`
	rec := post(t, h, "/v1/logs", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	var got accepted
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Accepted != 2 || len(got.Rejected) != 1 || got.Rejected[0].Error != ReasonEnvironmentNotAllowed ||
		got.Rejected[0].Environment != "production" || got.Rejected[0].Records != 2 || got.Rejected[0].AppID != "storefront" {
		t.Fatalf("response %+v", got)
	}
	if len(sink.logs) != 2 || sink.logs[0].Message != "a" || sink.logs[1].Message != "d" {
		t.Fatalf("stored %+v", sink.logs)
	}
	if n := testutil.ToFloat64(e.appRejected.WithLabelValues(ReasonEnvironmentNotAllowed)); n != 2 {
		t.Fatalf("app rejected metric = %v", n)
	}
	if n := testutil.ToFloat64(e.records.WithLabelValues("logs", "rejected")); n != 2 {
		t.Fatalf("records rejected metric = %v", n)
	}

	// Every record of another environment: 403 with the reason.
	rec = post(t, h, "/v1/requests", validRequest, nil) // environment "" is production
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"error":"environment_not_allowed"`) {
		t.Fatalf("all rejected: %d %s", rec.Code, rec.Body)
	}
	if len(sink.requests) != 0 {
		t.Fatalf("stored %+v", sink.requests)
	}
}

func TestEnvironmentPinnedKeyHeartbeatAndMetadata(t *testing.T) {
	meta, hb := &fakeMetadata{}, &fakeHeartbeats{}
	_, h := newPinnedEdge(t, []string{"production"}, &fakeSink{}, meta, hb)

	// validMetadata reports staging.
	if rec := post(t, h, "/v1/metadata", validMetadata, nil); rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), `"error":"environment_not_allowed"`) {
		t.Fatalf("metadata: %d %s", rec.Code, rec.Body)
	}
	if len(meta.rows) != 0 {
		t.Fatalf("metadata stored %+v", meta.rows)
	}
	if rec := post(t, h, "/v1/metadata", strings.Replace(validMetadata, `"staging"`, `"production"`, 1), nil); rec.Code != http.StatusOK {
		t.Fatalf("metadata production: %d %s", rec.Code, rec.Body)
	}

	hbBody := func(env string) string {
		return `{"app_id":"storefront","environment":"` + env + `","instance_id":"i-1","sdk_name":"apilenss"}`
	}
	if rec := post(t, h, "/v1/heartbeat", hbBody("staging"), nil); rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), `"error":"environment_not_allowed"`) {
		t.Fatalf("heartbeat: %d %s", rec.Code, rec.Body)
	}
	if len(hb.rows) != 0 {
		t.Fatalf("heartbeat stored %+v", hb.rows)
	}
	if rec := post(t, h, "/v1/heartbeat", hbBody(""), nil); rec.Code != http.StatusOK {
		t.Fatalf("heartbeat production: %d %s", rec.Code, rec.Body)
	}
}

func TestEnvironmentPinnedKeyOTLPPartialSuccess(t *testing.T) {
	sink := &fakeSink{}
	_, h := newPinnedEdge(t, []string{"staging"}, sink, &fakeMetadata{}, &fakeHeartbeats{})
	span := &tracepb.Span{
		TraceId: traceID, SpanId: spanID, Name: "GET /orders/{id}", Kind: tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 25_000_000,
	}
	prod := &resourcepb.Resource{Attributes: append(resource("storefront").Attributes[:0:0],
		str("service.name", "storefront"), str("deployment.environment.name", "production"))}
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}}},
		{Resource: prod, ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span, span}}}},
	}}
	rec := otlpPost(t, h, "/otlp/v1/traces", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if len(sink.spans) != 1 || sink.spans[0].Environment != "staging" {
		t.Fatalf("stored %+v", sink.spans)
	}
	if !strings.Contains(rec.Body.String(), "environment 'production'") {
		t.Fatalf("partial success message missing: %q", rec.Body.String())
	}
}
