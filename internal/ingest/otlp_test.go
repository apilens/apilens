package ingest

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func str(k, v string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: v}}}
}

func num(k string, v int64) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: v}}}
}

func resource(service string) *resourcepb.Resource {
	return &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
		str("service.name", service), str("deployment.environment.name", "staging"), str("service.version", "1.4.0"),
	}}
}

func otlpPost(t *testing.T, h http.Handler, path string, m proto.Message) *httptest.ResponseRecorder {
	t.Helper()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", contentProtobuf)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

var (
	traceID = []byte{0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36}
	spanID  = []byte{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}
	startNs = uint64(fixedNow.Add(-time5s).UnixNano())
)

const time5s = 5_000_000_000

func TestOTLPTracesWithPartialSuccess(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)
	span := &tracepb.Span{
		TraceId: traceID, SpanId: spanID, Name: "GET /orders/{id}", Kind: tracepb.Span_SPAN_KIND_SERVER,
		StartTimeUnixNano: startNs, EndTimeUnixNano: startNs + 25_000_000,
		Status:     &tracepb.Status{Code: tracepb.Status_STATUS_CODE_ERROR},
		Attributes: []*commonpb.KeyValue{num("http.response.status_code", 502), str("http.route", "/orders/{id}")},
	}
	req := &coltrace.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{
		{Resource: resource("storefront"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span}}}},
		{Resource: resource("unknown-svc"), ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{span, span}}}},
	}}
	rec := otlpPost(t, h, "/otlp/v1/traces", req)
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var resp coltrace.ExportTraceServiceResponse
	if err := proto.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.GetPartialSuccess().GetRejectedSpans() != 2 || !strings.Contains(resp.GetPartialSuccess().GetErrorMessage(), "unknown-svc") {
		t.Fatalf("partial success = %+v", resp.GetPartialSuccess())
	}
	if len(sink.spans) != 1 {
		t.Fatalf("stored %d spans", len(sink.spans))
	}
	s := sink.spans[0]
	if s.AppID != testApp || s.Kind != "server" || s.Status != "error" || s.StatusCode != http.StatusBadGateway ||
		s.DurationMs != 25 || s.Environment != "staging" || s.Release != "1.4.0" ||
		s.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || s.ServiceName != "storefront" {
		t.Fatalf("span row = %+v", s)
	}
}

func TestOTLPLogs(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)
	req := &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{str("apilens.app", "storefront"), str("service.name", "ignored")}},
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope: &commonpb.InstrumentationScope{Name: "checkout.logger"},
			LogRecords: []*logspb.LogRecord{{
				TimeUnixNano: startNs, SeverityNumber: logspb.SeverityNumber_SEVERITY_NUMBER_ERROR2,
				Body:       &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "payment failed"}},
				Attributes: []*commonpb.KeyValue{str("http.request.method", "post"), str("http.route", "/charge")},
				TraceId:    traceID, SpanId: spanID,
			}},
		}},
	}}}
	rec := otlpPost(t, h, "/otlp/v1/logs", req)
	if rec.Code != 200 || len(sink.logs) != 1 {
		t.Fatalf("code = %d, logs = %d", rec.Code, len(sink.logs))
	}
	l := sink.logs[0]
	if l.Level != "ERROR" || l.Message != "payment failed" || l.LoggerName != "checkout.logger" ||
		l.EndpointMethod != "POST" || l.EndpointPath != "/charge" || l.SpanID != "00f067aa0ba902b7" {
		t.Fatalf("log row = %+v", l)
	}
}

func TestOTLPJSONHexIDs(t *testing.T) {
	sink := &fakeSink{}
	h := newEdge(t, fakeVerifier{}, sink)
	body := `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"storefront"}}]},
	  "scopeSpans":[{"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7",
	  "name":"op","kind":2,"startTimeUnixNano":"` + itoa(startNs) + `","endTimeUnixNano":"` + itoa(startNs+1_000_000) + `"}]}]}]}`
	req := httptest.NewRequest(http.MethodPost, "/otlp/v1/traces", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", testKey)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || len(sink.spans) != 1 || sink.spans[0].TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("code = %d body = %s spans = %+v", rec.Code, rec.Body, sink.spans)
	}
	if ct := rec.Header().Get("Content-Type"); ct != contentJSON {
		t.Fatalf("response content type = %q", ct)
	}
}

func TestOTLPErrors(t *testing.T) {
	h := newEdge(t, fakeVerifier{}, &fakeSink{})
	req := httptest.NewRequest(http.MethodPost, "/otlp/v1/traces", strings.NewReader("garbage"))
	req.Header.Set("Content-Type", contentProtobuf)
	req.Header.Set("X-API-Key", testKey)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("garbage: %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/otlp/v1/traces", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "text/plain")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("content type: %d", rec.Code)
	}

	rec = otlpPost(t, newEdge(t, fakeVerifier{}, &fakeSink{}), "/otlp/v1/traces", &coltrace.ExportTraceServiceRequest{})
	if rec.Code != 200 {
		t.Fatalf("empty export should succeed, got %d", rec.Code)
	}
}

func itoa(v uint64) string {
	var b [20]byte
	i := len(b)
	for v >= 10 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	i--
	b[i] = byte('0' + v)
	return string(b[i:])
}
