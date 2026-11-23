package ingest

import (
	"net/http"
	"testing"

	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestOTLPServerSpansBecomeRequests(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)
	server := &tracepb.Span{
		TraceId: traceID, SpanId: spanID, Name: "GET /api/v1", Kind: tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 40_000_000,
		Attributes: []*commonpb.KeyValue{
			str("http.request.method", "GET"), str("http.route", "/api/v1"), str("url.path", "//api/v1/users/42/sessions"),
			num("http.response.status_code", 401), str("client.address", "10.0.0.7"), str("user_agent.original", "curl/8"),
			str("url.scheme", "https"), str("server.address", "backend"), num("server.port", 443),
		},
	}
	client := &tracepb.Span{
		TraceId: traceID, SpanId: []byte{1, 2, 3, 4, 5, 6, 7, 8}, Name: "SELECT users", Kind: tracepb.Span_SPAN_KIND_CLIENT,
		StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 1_000_000,
	}
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{server, client}}}},
	}}
	if rec := otlpPost(t, h, "/otlp/v1/traces", req); rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	if len(sink.spans) != 2 || len(sink.requests) != 1 {
		t.Fatalf("spans = %d, requests = %d", len(sink.spans), len(sink.requests))
	}
	r := sink.requests[0]
	if r.AppID != testApp || r.Method != "GET" || r.Path != "/api/v1/users/{id}/sessions" || r.RawPath != "/api/v1/users/42/sessions" ||
		r.StatusCode != http.StatusUnauthorized || r.ResponseTimeMs != 40 || r.IPAddress != "10.0.0.7" || r.UserAgent != "curl/8" ||
		r.BaseURL != "https://backend:443" || r.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || r.Environment != "staging" ||
		r.Release != "1.4.0" || !r.Sampled {
		t.Fatalf("request row = %+v", r)
	}
}

func TestRequestPath(t *testing.T) {
	for _, c := range []struct{ route, raw, want string }{
		{"/orders/{id}", "/orders/7", "/orders/{id}"},
		{"/api/v1", "/api/v1/users/550e8400-e29b-41d4-a716-446655440000", "/api/v1/users/{uuid}"},
		{"/api/v1", "/api/v1", "/api/v1"},
		{"", "/blobs/4bf92f3577b34da6a3ce929d0e0e4736?x=1", "/blobs/{id}"},
		{"/", "/health", "/health"},
		{"", "", ""},
	} {
		if got := requestPath(c.route, cleanPath(c.raw)); got != c.want {
			t.Errorf("requestPath(%q, %q) = %q, want %q", c.route, c.raw, got, c.want)
		}
	}
}
