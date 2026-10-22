package ingest

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	collogs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	coltrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/pipeline"
)

// OTLP/HTTP receivers (https://opentelemetry.io/docs/specs/otlp/#otlphttp).
// Exporters point OTEL_EXPORTER_OTLP_ENDPOINT at https://<ingest>/otlp and
// send the API key as a header (X-API-Key or Authorization: Bearer).
//
// Resource attributes select the app and environment:
//
//	apilens.app (preferred) or service.name -> app slug or UUID
//	deployment.environment.name / deployment.environment -> environment
//	service.version -> release ; vcs.ref.head.revision -> commit
//
// Records for unknown apps are rejected through OTLP partial success, which
// tells exporters not to retry them.

const (
	contentProtobuf = "application/x-protobuf"
	contentJSON     = "application/json"
	maxOTLPRecords  = 100_000
)

type otlpCodec struct{ json bool }

func (c otlpCodec) unmarshal(body []byte, m proto.Message) error {
	if !c.json {
		return proto.Unmarshal(body, m)
	}
	// OTLP/JSON encodes trace and span ids as hex, protojson expects base64.
	fixed, err := hexIDsToBase64(body)
	if err != nil {
		return err
	}
	return protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(fixed, m)
}

func (c otlpCodec) write(w http.ResponseWriter, code int, m proto.Message) {
	var (
		b   []byte
		err error
	)
	if c.json {
		w.Header().Set("Content-Type", contentJSON)
		b, err = protojson.Marshal(m)
	} else {
		w.Header().Set("Content-Type", contentProtobuf)
		b, err = proto.Marshal(m)
	}
	if err != nil {
		code = http.StatusInternalServerError
		b = nil
	}
	w.WriteHeader(code)
	_, _ = w.Write(b)
}

// otlpFail answers with a google.rpc.Status body as the spec requires.
func (e *Edge) otlpFail(w http.ResponseWriter, c otlpCodec, signal string, aerr *apiError) {
	if aerr.retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(aerr.retryAfter.Seconds())))
	}
	e.batches.WithLabelValues(signal, strconv.Itoa(aerr.status)).Inc()
	c.write(w, aerr.status, &status.Status{Code: grpcCode(aerr.status), Message: fmt.Sprint(aerr.Detail)})
}

func grpcCode(httpStatus int) int32 {
	switch httpStatus {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return 3 // INVALID_ARGUMENT
	case http.StatusUnauthorized:
		return 16 // UNAUTHENTICATED
	case http.StatusForbidden:
		return 7 // PERMISSION_DENIED
	case http.StatusRequestEntityTooLarge:
		return 8 // RESOURCE_EXHAUSTED
	case http.StatusServiceUnavailable:
		return 14 // UNAVAILABLE
	default:
		return 13 // INTERNAL
	}
}

func (e *Edge) otlpRequest(w http.ResponseWriter, r *http.Request, signal string, m proto.Message) (apikeys.Principal, otlpCodec, bool) {
	var c otlpCodec
	switch mediaType(r) {
	case contentProtobuf:
	case contentJSON:
		c.json = true
	default:
		e.otlpFail(w, c, signal, &apiError{status: http.StatusUnsupportedMediaType, Detail: "Content-Type must be application/x-protobuf or application/json"})
		return apikeys.Principal{}, c, false
	}
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return p, c, false
	}
	body, aerr := e.readBody(w, r)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return p, c, false
	}
	if err := c.unmarshal(body, m); err != nil {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusBadRequest, Detail: "invalid OTLP payload: " + err.Error()})
		return p, c, false
	}
	return p, c, true
}

// resourceInfo is what we take from an OTLP resource.
type resourceInfo struct {
	app, environment, service, release, commit string
}

func readResource(attrs []*commonpb.KeyValue) resourceInfo {
	var ri resourceInfo
	for _, kv := range attrs {
		v := anyString(kv.GetValue())
		switch kv.GetKey() {
		case "apilens.app":
			ri.app = v
		case "service.name":
			ri.service = v
		case "deployment.environment.name":
			ri.environment = v
		case "deployment.environment":
			if ri.environment == "" {
				ri.environment = v
			}
		case "service.version":
			ri.release = v
		case "vcs.ref.head.revision", "apilens.commit":
			ri.commit = v
		}
	}
	if ri.app == "" {
		ri.app = ri.service
	}
	return ri
}

func (e *Edge) resolveResourceApps(r *http.Request, p apikeys.Principal, resources []resourceInfo) (map[string]uuid.UUID, []string, *apiError) {
	var idents []string
	seen := map[string]bool{}
	for _, ri := range resources {
		if ri.app != "" && !seen[ri.app] {
			seen[ri.app] = true
			idents = append(idents, ri.app)
		}
	}
	found := map[string]uuid.UUID{}
	var unknown []string
	if len(idents) == 0 {
		return found, nil, nil
	}
	// Resolve one at a time only when the batch resolution fails, so a single
	// unknown service does not reject the whole export.
	m, aerr := e.resolveApps(r.Context(), p, nil, idents, false)
	if aerr == nil {
		return m, nil, nil
	}
	if aerr.status != http.StatusUnprocessableEntity {
		return nil, nil, aerr
	}
	for _, id := range idents {
		one, aerr := e.resolveApps(r.Context(), p, nil, []string{id}, false)
		switch {
		case aerr == nil:
			found[id] = one[id]
		case aerr.status == http.StatusUnprocessableEntity:
			unknown = append(unknown, id)
		default:
			return nil, nil, aerr
		}
	}
	return found, unknown, nil
}

func (e *Edge) handleOTLPTraces(w http.ResponseWriter, r *http.Request) {
	const signal = "otlp_spans"
	var req coltrace.ExportTraceServiceRequest
	p, c, ok := e.otlpRequest(w, r, signal, &req)
	if !ok {
		return
	}
	resources := make([]resourceInfo, len(req.GetResourceSpans()))
	total := 0
	for i, rs := range req.GetResourceSpans() {
		resources[i] = readResource(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			total += len(ss.GetSpans())
		}
	}
	if total > maxOTLPRecords {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusRequestEntityTooLarge, Detail: fmt.Sprintf("at most %d spans per export", maxOTLPRecords)})
		return
	}
	apps, unknown, aerr := e.resolveResourceApps(r, p, resources)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.SpanRow, 0, total)
	var rejected int64
	for i, rs := range req.GetResourceSpans() {
		ri := resources[i]
		appID, known := apps[ri.app]
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				row, valid := spanRow(sp, ri, now)
				if !known || !valid {
					rejected++
					continue
				}
				row.ProjectID, row.AppID = p.ProjectID, appID
				rows = append(rows, row)
			}
		}
	}
	if len(rows) > 0 {
		if err := e.sink.SubmitSpans(r.Context(), rows); err != nil {
			e.otlpFail(w, c, signal, e.submitError(err))
			return
		}
	}
	e.records.WithLabelValues(signal, "accepted").Add(float64(len(rows)))
	e.records.WithLabelValues(signal, "rejected").Add(float64(rejected))
	e.batches.WithLabelValues(signal, "200").Inc()
	resp := &coltrace.ExportTraceServiceResponse{}
	if rejected > 0 {
		resp.PartialSuccess = &coltrace.ExportTracePartialSuccess{RejectedSpans: rejected, ErrorMessage: rejectionMessage(unknown)}
	}
	c.write(w, http.StatusOK, resp)
}

func spanRow(sp *tracepb.Span, ri resourceInfo, now time.Time) (pipeline.SpanRow, bool) {
	traceID := hexID(hex.EncodeToString(sp.GetTraceId()), traceIDHexLen)
	spanID := hexID(hex.EncodeToString(sp.GetSpanId()), spanIDHexLen)
	start := unixNano(sp.GetStartTimeUnixNano())
	if traceID == "" || spanID == "" || !validTimestamp(start, now) {
		return pipeline.SpanRow{}, false
	}
	var durationMs float64
	if end := sp.GetEndTimeUnixNano(); end > sp.GetStartTimeUnixNano() {
		durationMs = float64(end-sp.GetStartTimeUnixNano()) / 1e6
	}
	attrs, statusCode := otlpAttributes(sp.GetAttributes())
	st := "ok"
	if sp.GetStatus().GetCode() == tracepb.Status_STATUS_CODE_ERROR {
		st = "error"
	}
	return pipeline.SpanRow{
		Environment:  environment(ri.environment),
		Timestamp:    start,
		TraceID:      traceID,
		SpanID:       spanID,
		ParentSpanID: hexID(hex.EncodeToString(sp.GetParentSpanId()), spanIDHexLen),
		Name:         short(sp.GetName()),
		Kind:         spanKind(sp.GetKind()),
		ServiceName:  short(ri.service),
		DurationMs:   durationMs,
		Status:       st,
		StatusCode:   statusCode,
		Attributes:   attrs,
		Release:      release(ri.release),
		Commit:       commit(ri.commit),
	}, true
}

// unixNano converts OTLP nanoseconds; out-of-range values become the zero
// time, which validTimestamp rejects.
func unixNano(ns uint64) time.Time {
	if ns > math.MaxInt64 {
		return time.Time{}
	}
	return time.Unix(0, int64(ns)).UTC()
}

func spanKind(k tracepb.Span_SpanKind) string {
	switch k {
	case tracepb.Span_SPAN_KIND_SERVER:
		return "server"
	case tracepb.Span_SPAN_KIND_CLIENT:
		return "client"
	case tracepb.Span_SPAN_KIND_PRODUCER:
		return "producer"
	case tracepb.Span_SPAN_KIND_CONSUMER:
		return "consumer"
	default:
		return "internal"
	}
}

func (e *Edge) handleOTLPLogs(w http.ResponseWriter, r *http.Request) {
	const signal = "otlp_logs"
	var req collogs.ExportLogsServiceRequest
	p, c, ok := e.otlpRequest(w, r, signal, &req)
	if !ok {
		return
	}
	resources := make([]resourceInfo, len(req.GetResourceLogs()))
	total := 0
	for i, rl := range req.GetResourceLogs() {
		resources[i] = readResource(rl.GetResource().GetAttributes())
		for _, sl := range rl.GetScopeLogs() {
			total += len(sl.GetLogRecords())
		}
	}
	if total > maxOTLPRecords {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusRequestEntityTooLarge, Detail: fmt.Sprintf("at most %d log records per export", maxOTLPRecords)})
		return
	}
	apps, unknown, aerr := e.resolveResourceApps(r, p, resources)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.LogRow, 0, total)
	var rejected int64
	for i, rl := range req.GetResourceLogs() {
		ri := resources[i]
		appID, known := apps[ri.app]
		for _, sl := range rl.GetScopeLogs() {
			scope := sl.GetScope().GetName()
			for _, lr := range sl.GetLogRecords() {
				row, valid := logRow(lr, ri, scope, now)
				if !known || !valid {
					rejected++
					continue
				}
				row.ProjectID, row.AppID = p.ProjectID, appID
				rows = append(rows, row)
			}
		}
	}
	if len(rows) > 0 {
		if err := e.sink.SubmitLogs(r.Context(), rows); err != nil {
			e.otlpFail(w, c, signal, e.submitError(err))
			return
		}
	}
	e.records.WithLabelValues(signal, "accepted").Add(float64(len(rows)))
	e.records.WithLabelValues(signal, "rejected").Add(float64(rejected))
	e.batches.WithLabelValues(signal, "200").Inc()
	resp := &collogs.ExportLogsServiceResponse{}
	if rejected > 0 {
		resp.PartialSuccess = &collogs.ExportLogsPartialSuccess{RejectedLogRecords: rejected, ErrorMessage: rejectionMessage(unknown)}
	}
	c.write(w, http.StatusOK, resp)
}

func logRow(lr *logspb.LogRecord, ri resourceInfo, scope string, now time.Time) (pipeline.LogRow, bool) {
	ns := lr.GetTimeUnixNano()
	if ns == 0 {
		ns = lr.GetObservedTimeUnixNano()
	}
	ts := now.UTC()
	if ns != 0 {
		ts = unixNano(ns)
	}
	if !validTimestamp(ts, now) {
		return pipeline.LogRow{}, false
	}
	attrs, statusCode := otlpAttributes(lr.GetAttributes())
	level := logLevel(lr.GetSeverityText())
	if lr.GetSeverityText() == "" {
		level = severityLevel(lr.GetSeverityNumber())
	}
	return pipeline.LogRow{
		Environment:    environment(ri.environment),
		Timestamp:      ts,
		Level:          level,
		Message:        truncate(anyString(lr.GetBody()), maxLogMessageChars),
		LoggerName:     short(scope),
		EndpointMethod: truncate(strings.ToUpper(attrs["http.request.method"]), 16),
		EndpointPath:   short(firstNonEmpty(attrs["http.route"], attrs["url.path"])),
		StatusCode:     statusCode,
		TraceID:        hexID(hex.EncodeToString(lr.GetTraceId()), traceIDHexLen),
		SpanID:         hexID(hex.EncodeToString(lr.GetSpanId()), spanIDHexLen),
		Attributes:     attrs,
		Release:        release(ri.release),
		Commit:         commit(ri.commit),
	}, true
}

func severityLevel(n logspb.SeverityNumber) string {
	switch {
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_FATAL:
		return "CRITICAL"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_ERROR:
		return "ERROR"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_WARN:
		return "WARNING"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_INFO, n == logspb.SeverityNumber_SEVERITY_NUMBER_UNSPECIFIED:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// otlpAttributes flattens OTLP attributes into bounded strings and extracts
// the HTTP status code (stable or legacy semantic convention).
func otlpAttributes(kvs []*commonpb.KeyValue) (map[string]string, uint16) {
	if len(kvs) == 0 {
		return nil, 0
	}
	out := make(map[string]string, min(len(kvs), maxAttributes))
	var statusCode uint16
	for _, kv := range kvs {
		key := kv.GetKey()
		if key == "http.response.status_code" || key == "http.status_code" {
			if code := kv.GetValue().GetIntValue(); code > 0 {
				statusCode = clampStatus(int(code))
			} else if code, err := strconv.Atoi(kv.GetValue().GetStringValue()); err == nil {
				statusCode = clampStatus(code)
			}
		}
		if len(out) >= maxAttributes {
			continue
		}
		key = truncate(strings.TrimSpace(key), maxAttributeKeyChars)
		if key == "" || kv.GetValue().GetKvlistValue() != nil || kv.GetValue().GetArrayValue() != nil {
			continue
		}
		out[key] = truncate(anyString(kv.GetValue()), maxAttributeValueChars)
	}
	return out, statusCode
}

func anyString(v *commonpb.AnyValue) string {
	if v == nil {
		return ""
	}
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_BoolValue:
		return strconv.FormatBool(x.BoolValue)
	case *commonpb.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10)
	case *commonpb.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'g', -1, 64)
	case *commonpb.AnyValue_BytesValue:
		return base64.StdEncoding.EncodeToString(x.BytesValue)
	default:
		b, err := protojson.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func rejectionMessage(unknown []string) string {
	if len(unknown) == 0 {
		return "some records had invalid ids or timestamps"
	}
	return "unknown app (set resource attribute apilens.app or service.name to an app slug): " + strings.Join(unknown, ", ")
}

// hexIDsToBase64 rewrites traceId/spanId/parentSpanId hex strings in an
// OTLP/JSON document into the base64 form protojson expects.
func hexIDsToBase64(body []byte) ([]byte, error) {
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, val := range x {
				switch k {
				case "traceId", "spanId", "parentSpanId", "trace_id", "span_id", "parent_span_id":
					if s, ok := val.(string); ok && s != "" {
						if raw, err := hex.DecodeString(s); err == nil {
							x[k] = base64.StdEncoding.EncodeToString(raw)
						}
					}
				default:
					walk(val)
				}
			}
		case []any:
			for _, item := range x {
				walk(item)
			}
		}
	}
	walk(doc)
	return json.Marshal(doc)
}
