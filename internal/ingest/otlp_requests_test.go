package ingest

import (
	"encoding/base64"
	"net/http"
	"strings"
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

func TestOTLPServerSpanPayloadsAreMaskedAndNotSpanAttributes(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)
	server := &tracepb.Span{
		TraceId: traceID, SpanId: spanID, Name: "POST /login", Kind: tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 5_000_000,
		Attributes: []*commonpb.KeyValue{
			str("http.request.method", "POST"), str("http.route", "/login"), num("http.response.status_code", 200),
			str("apilens.request.body", `{"user":"neel","password":"hunter2"}`),
			str("apilens.response.body", `{"ok":true}`),
			str("apilens.request.headers", `{"authorization":"Bearer abc","accept":"*/*"}`),
			str("apilens.response.headers", `{"content-type":"application/json"}`),
		},
	}
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{server}}}},
	}}
	if rec := otlpPost(t, h, "/otlp/v1/traces", req); rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	if len(sink.spans) != 1 || len(sink.requests) != 1 {
		t.Fatalf("spans = %d, requests = %d", len(sink.spans), len(sink.requests))
	}
	for k := range sink.spans[0].Attributes {
		if isPayloadAttribute(k) {
			t.Fatalf("span kept payload attribute %q", k)
		}
	}
	r := sink.requests[0]
	if strings.Contains(r.RequestPayload, "hunter2") || !strings.Contains(r.RequestPayload, `"user":"neel"`) {
		t.Fatalf("request payload = %s", r.RequestPayload)
	}
	if strings.Contains(r.RequestHeaders, "Bearer abc") || !strings.Contains(r.RequestHeaders, `"accept":"*/*"`) {
		t.Fatalf("request headers = %s", r.RequestHeaders)
	}
	if r.ResponsePayload != `{"ok":true}` || r.ResponseHeaders != `{"content-type":"application/json"}` {
		t.Fatalf("response = %s %s", r.ResponsePayload, r.ResponseHeaders)
	}
}

func TestBearerConsumer(t *testing.T) {
	jwt := func(claims string) string {
		return "eyJhbGciOiJSUzUxMiJ9." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".c2ln"
	}
	for _, c := range []struct {
		headers string
		want    consumerInfo
	}{
		// Motadata: sub is the constant "Motadata API v1"; id and user.name name the user.
		{`{"authorization":"Bearer ` + jwt(`{"user.name":"admin","id":10000000000000001,"session-id":"s","sub":"Motadata API v1"}`) + `"}`,
			consumerInfo{id: "10000000000000001", name: "admin"}},
		{`{"Authorization":"bearer ` + jwt(`{"sub":"u-42","email":"a@b.c","tenant":"acme"}`) + `"}`,
			consumerInfo{id: "u-42", name: "a@b.c", group: "acme"}},
		{`{"authorization":"Bearer ` + jwt(`{"preferred_username":"neel"}`) + `"}`, consumerInfo{id: "neel", name: "neel"}},
		{`{"authorization":"Basic dXNlcjpwYXNz"}`, consumerInfo{}},
		{`{"authorization":"Bearer opaque-token"}`, consumerInfo{}},
		{`{"accept":"*/*"}`, consumerInfo{}},
		{``, consumerInfo{}},
	} {
		if got := bearerConsumer(c.headers); got != c.want {
			t.Errorf("bearerConsumer(%s) = %+v, want %+v", c.headers, got, c.want)
		}
	}
}
