package ingest

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
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
	"github.com/apilens/apilens/internal/controlplane/privacy"
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
		w.Header().Set("Retry-After", retryAfterSeconds(aerr.retryAfter))
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
	case http.StatusRequestEntityTooLarge, http.StatusTooManyRequests:
		return 8 // RESOURCE_EXHAUSTED
	case http.StatusServiceUnavailable:
		return 14 // UNAVAILABLE
	default:
		return 13 // INTERNAL
	}
}

// otlpRequest authenticates and decodes an export; it returns the
// decompressed body size for the byte quota.
func (e *Edge) otlpRequest(w http.ResponseWriter, r *http.Request, signal string, m proto.Message) (apikeys.Principal, otlpCodec, int, bool) {
	var c otlpCodec
	switch mediaType(r) {
	case contentProtobuf:
	case contentJSON:
		c.json = true
	default:
		e.otlpFail(w, c, signal, &apiError{status: http.StatusUnsupportedMediaType, Detail: "Content-Type must be application/x-protobuf or application/json"})
		return apikeys.Principal{}, c, 0, false
	}
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return p, c, 0, false
	}
	body, aerr := e.readBody(w, r)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return p, c, 0, false
	}
	if err := c.unmarshal(body, m); err != nil {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusBadRequest, Detail: "invalid OTLP payload: " + err.Error()})
		return p, c, 0, false
	}
	return p, c, len(body), true
}

// resourceInfo is what we take from an OTLP resource.
type resourceInfo struct {
	app, environment, service, release, commit string
	records                                    int // spans or log records under the resource
}

// resourceEnvs lists the normalised environment of every record of an
// export, in the order of resourceIdents.
func resourceEnvs(resources []resourceInfo) []string {
	var envs []string
	for _, ri := range resources {
		env := environment(ri.environment)
		for range ri.records {
			envs = append(envs, env)
		}
	}
	return envs
}

// resourceIdents lists the app identifier of every record of an export.
func resourceIdents(resources []resourceInfo) []string {
	var idents []string
	for _, ri := range resources {
		for range ri.records {
			idents = append(idents, ri.app)
		}
	}
	return idents
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

// resolveResourceApps resolves the app of every resource (apilens.app, else
// service.name; neither is the default app). Resources whose app is refused,
// or whose environment the key may not send for, are reported in rejected;
// their records count as rejected in a partial success, so one bad service
// does not fail the whole export.
func (e *Edge) resolveResourceApps(r *http.Request, signal string, p apikeys.Principal, resources []resourceInfo, t tally) (map[string]uuid.UUID, []string, int64, *apiError) {
	b, aerr := e.resolveBatch(r.Context(), signal, p, nil, resourceIdents(resources), resourceEnvs(resources), false, t)
	if b == nil {
		return nil, nil, 0, aerr
	}
	var rejected []string
	for _, rep := range b.report {
		rejected = append(rejected, rep.Detail)
	}
	return b.apps, rejected, int64(b.dropped), nil
}

func (e *Edge) handleOTLPTraces(w http.ResponseWriter, r *http.Request) {
	const signal = "otlp_spans"
	var req coltrace.ExportTraceServiceRequest
	p, c, size, ok := e.otlpRequest(w, r, signal, &req)
	if !ok {
		return
	}
	resources := make([]resourceInfo, len(req.GetResourceSpans()))
	total := 0
	for i, rs := range req.GetResourceSpans() {
		resources[i] = readResource(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			resources[i].records += len(ss.GetSpans())
		}
		total += resources[i].records
	}
	if total > maxOTLPRecords {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusRequestEntityTooLarge, Detail: fmt.Sprintf("at most %d spans per export", maxOTLPRecords)})
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	if aerr := e.admit(r.Context(), p, total, size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, resourceIdents(resources), t)
		e.otlpFail(w, c, signal, aerr)
		return
	}
	apps, unknown, counted, aerr := e.resolveResourceApps(r, signal, p, resources, t)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.SpanRow, 0, total)
	var excLogs []pipeline.LogRow
	rds := e.redactors(p.ProjectID)
	var rejected int64
	for i, rs := range req.GetResourceSpans() {
		ri := resources[i]
		appID, known := apps[ri.app]
		known = known && p.AllowsEnvironment(environment(ri.environment))
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				row, valid, cut := spanRow(sp, ri, now)
				if !known || !valid {
					rejected++
					if known {
						t.reject(appID, ReasonInvalid, 1)
					}
					continue
				}
				if cut {
					e.truncated.WithLabelValues(FieldSpanEvents).Inc()
					t.app(appID).Truncated++
				}
				row.ProjectID, row.AppID = p.ProjectID, appID
				rows = append(rows, row)
				logs := exceptionLogs(sp, row)
				if len(logs) == 0 {
					continue
				}
				red, aerr := rds.get(r.Context(), appID)
				if aerr != nil {
					e.otlpFail(w, c, signal, aerr)
					return
				}
				for j := range logs {
					if redactLogRow(red, &logs[j]) {
						e.masked.WithLabelValues("logs").Inc()
						t.app(appID).Masked++
					}
				}
				excLogs = append(excLogs, logs...)
			}
		}
	}
	if len(rows) > 0 {
		if err := e.sink.SubmitSpans(r.Context(), rows); err != nil {
			e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
			for _, row := range rows {
				t.reject(row.AppID, ReasonStorageUnavailable, 1)
			}
			e.otlpFail(w, c, signal, e.submitError(err))
			return
		}
	}
	// Exception logs make OTLP exceptions show in Errors like the SDKs' own.
	// They derive from accepted spans and are not counted as records.
	if len(excLogs) > 0 {
		if err := e.sink.SubmitLogs(r.Context(), excLogs); err != nil {
			e.otlpFail(w, c, signal, e.submitError(err))
			return
		}
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.records.WithLabelValues(signal, "accepted").Add(float64(len(rows)))
	e.records.WithLabelValues(signal, "rejected").Add(float64(rejected - counted)) // app rejections are counted by resolveBatch
	e.batches.WithLabelValues(signal, "200").Inc()
	resp := &coltrace.ExportTraceServiceResponse{}
	if rejected > 0 {
		resp.PartialSuccess = &coltrace.ExportTracePartialSuccess{RejectedSpans: rejected, ErrorMessage: rejectionMessage(unknown)}
	}
	c.write(w, http.StatusOK, resp)
}

// spanRow maps an OTLP span; cut reports that its events or links were cut
// to the caps of span_events.go.
func spanRow(sp *tracepb.Span, ri resourceInfo, now time.Time) (row pipeline.SpanRow, valid, cut bool) {
	traceID := hexID(hex.EncodeToString(sp.GetTraceId()), traceIDHexLen)
	spanID := hexID(hex.EncodeToString(sp.GetSpanId()), spanIDHexLen)
	start := unixNano(sp.GetStartTimeUnixNano())
	if traceID == "" || spanID == "" || !validTimestamp(start, now) {
		return pipeline.SpanRow{}, false, false
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
	events, eventsCut := spanEvents(otlpSpanEvents(sp.GetEvents()), start)
	links, linksCut := spanLinks(otlpSpanLinks(sp.GetLinks()))
	return pipeline.SpanRow{
		Environment:   environment(ri.environment),
		Timestamp:     start,
		TraceID:       traceID,
		SpanID:        spanID,
		ParentSpanID:  hexID(hex.EncodeToString(sp.GetParentSpanId()), spanIDHexLen),
		Name:          short(sp.GetName()),
		Kind:          spanKind(sp.GetKind()),
		ServiceName:   short(ri.service),
		DurationMs:    durationMs,
		Status:        st,
		StatusCode:    statusCode,
		Attributes:    attrs,
		Release:       release(ri.release),
		Commit:        commit(ri.commit),
		StatusMessage: truncate(strings.TrimSpace(sp.GetStatus().GetMessage()), maxSpanStatusMessageChars),
		Events:        events,
		Links:         links,
	}, true, eventsCut || linksCut
}

// otlpSpanEvents converts OTLP span events into the JSON span schema so both
// receivers apply the same caps. Nested (kvlist and array) attribute values
// are dropped, as for span attributes.
func otlpSpanEvents(in []*tracepb.Span_Event) []spanEventRecord {
	if len(in) == 0 {
		return nil
	}
	out := make([]spanEventRecord, len(in))
	for i, ev := range in {
		var ts time.Time
		if ns := ev.GetTimeUnixNano(); ns != 0 {
			ts = unixNano(ns)
		}
		var attrs map[string]json.RawMessage
		for _, kv := range ev.GetAttributes() {
			v := kv.GetValue()
			if v.GetKvlistValue() != nil || v.GetArrayValue() != nil {
				continue
			}
			raw, err := json.Marshal(anyString(v))
			if err != nil {
				continue
			}
			if attrs == nil {
				attrs = make(map[string]json.RawMessage, len(ev.GetAttributes()))
			}
			attrs[kv.GetKey()] = raw
		}
		out[i] = spanEventRecord{Timestamp: flexTime{ts}, Name: ev.GetName(), Attributes: attrs}
	}
	return out
}

func otlpSpanLinks(in []*tracepb.Span_Link) []spanLinkRecord {
	if len(in) == 0 {
		return nil
	}
	out := make([]spanLinkRecord, len(in))
	for i, l := range in {
		out[i] = spanLinkRecord{TraceID: hex.EncodeToString(l.GetTraceId()), SpanID: hex.EncodeToString(l.GetSpanId())}
	}
	return out
}

const (
	// exceptionEvent is the semantic-convention name of a recorded exception.
	exceptionEvent = "exception"
	// exceptionLogger is the logger name of the exception records the SDKs
	// write when a handler raises (and the Errors page reads).
	exceptionLogger = "apilens.exception"
)

// exceptionLogs is an apilens.exception log for every exception event of a
// span within the event cap, shaped like the SDKs' own: message
// "<type>: <message>", the stack trace as payload, on the span so it shows
// in Errors and in the trace. Message and payload are capped by redactLogRow.
func exceptionLogs(sp *tracepb.Span, row pipeline.SpanRow) []pipeline.LogRow {
	var out []pipeline.LogRow
	evs := sp.GetEvents()
	for _, ev := range evs[:min(len(evs), maxSpanEvents)] {
		if ev.GetName() != exceptionEvent {
			continue
		}
		var typ, msg, stack string
		attrs := map[string]string{}
		for _, kv := range ev.GetAttributes() {
			v := anyString(kv.GetValue())
			switch kv.GetKey() {
			case "exception.type":
				typ = strings.TrimSpace(v)
			case "exception.message":
				msg = v
			case stacktraceKey:
				stack = v
				continue
			case "exception.escaped":
			default:
				continue
			}
			attrs[kv.GetKey()] = truncate(v, maxAttributeValueChars)
		}
		ts := row.Timestamp
		if ns := ev.GetTimeUnixNano(); ns != 0 {
			ts = unixNano(ns)
		}
		out = append(out, pipeline.LogRow{
			ProjectID:      row.ProjectID,
			AppID:          row.AppID,
			Environment:    row.Environment,
			Timestamp:      ts,
			Level:          "ERROR",
			Message:        exceptionMessage(typ, msg),
			LoggerName:     exceptionLogger,
			EndpointMethod: truncate(strings.ToUpper(row.Attributes["http.request.method"]), 16),
			EndpointPath:   short(firstNonEmpty(row.Attributes["http.route"], row.Attributes["url.path"])),
			StatusCode:     row.StatusCode,
			TraceID:        row.TraceID,
			SpanID:         row.SpanID,
			Payload:        stack,
			Attributes:     attrs,
			Release:        row.Release,
			Commit:         row.Commit,
		})
	}
	return out
}

func exceptionMessage(typ, msg string) string {
	switch {
	case typ != "" && msg != "":
		return typ + ": " + msg
	case typ != "":
		return typ
	case msg != "":
		return msg
	default:
		return exceptionEvent
	}
}

// redactLogRow masks a log row in place like redactLog, then caps its
// message and payload (masking sees whole values). It reports whether
// anything was masked.
func redactLogRow(r *privacy.Redactor, row *pipeline.LogRow) bool {
	msg, payload := r.Text(row.Message), r.Body(row.Payload)
	masked := msg != row.Message || payload != row.Payload
	row.Message = truncate(msg, maxLogMessageChars)
	row.Payload = truncateHeadTail(payload, maxLogPayloadChars)
	return masked
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
	p, c, size, ok := e.otlpRequest(w, r, signal, &req)
	if !ok {
		return
	}
	resources := make([]resourceInfo, len(req.GetResourceLogs()))
	total := 0
	for i, rl := range req.GetResourceLogs() {
		resources[i] = readResource(rl.GetResource().GetAttributes())
		for _, sl := range rl.GetScopeLogs() {
			resources[i].records += len(sl.GetLogRecords())
		}
		total += resources[i].records
	}
	if total > maxOTLPRecords {
		e.otlpFail(w, c, signal, &apiError{status: http.StatusRequestEntityTooLarge, Detail: fmt.Sprintf("at most %d log records per export", maxOTLPRecords)})
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	if aerr := e.admit(r.Context(), p, total, size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, resourceIdents(resources), t)
		e.otlpFail(w, c, signal, aerr)
		return
	}
	apps, unknown, counted, aerr := e.resolveResourceApps(r, signal, p, resources, t)
	if aerr != nil {
		e.otlpFail(w, c, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.LogRow, 0, total)
	rds := e.redactors(p.ProjectID)
	var rejected int64
	for i, rl := range req.GetResourceLogs() {
		ri := resources[i]
		appID, known := apps[ri.app]
		known = known && p.AllowsEnvironment(environment(ri.environment))
		for _, sl := range rl.GetScopeLogs() {
			scope := sl.GetScope().GetName()
			for _, lr := range sl.GetLogRecords() {
				row, valid := logRow(lr, ri, scope, now)
				if !known || !valid {
					rejected++
					if known {
						t.reject(appID, ReasonInvalid, 1)
					}
					continue
				}
				red, aerr := rds.get(r.Context(), appID)
				if aerr != nil {
					e.otlpFail(w, c, signal, aerr)
					return
				}
				if redactLogRow(red, &row) {
					e.masked.WithLabelValues("logs").Inc()
					t.app(appID).Masked++
				}
				row.ProjectID, row.AppID = p.ProjectID, appID
				rows = append(rows, row)
			}
		}
	}
	if len(rows) > 0 {
		if err := e.sink.SubmitLogs(r.Context(), rows); err != nil {
			e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
			for _, row := range rows {
				t.reject(row.AppID, ReasonStorageUnavailable, 1)
			}
			e.otlpFail(w, c, signal, e.submitError(err))
			return
		}
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.records.WithLabelValues(signal, "accepted").Add(float64(len(rows)))
	e.records.WithLabelValues(signal, "rejected").Add(float64(rejected - counted)) // app rejections are counted by resolveBatch
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
	// exception.stacktrace is the payload (64 KiB head+tail), not an
	// attribute cut to maxAttributeValueChars.
	kvs, stack := lr.GetAttributes(), ""
	if i := slices.IndexFunc(kvs, func(kv *commonpb.KeyValue) bool { return kv.GetKey() == stacktraceKey }); i >= 0 {
		stack = anyString(kvs[i].GetValue())
		kvs = slices.Delete(slices.Clone(kvs), i, i+1)
	}
	attrs, statusCode := otlpAttributes(kvs)
	level := logLevel(lr.GetSeverityText())
	if lr.GetSeverityText() == "" {
		level = severityLevel(lr.GetSeverityNumber())
	}
	return pipeline.LogRow{
		Environment:    environment(ri.environment),
		Timestamp:      ts,
		Level:          level,
		Message:        anyString(lr.GetBody()), // capped by redactLogRow
		LoggerName:     short(scope),
		Payload:        stack,
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

func rejectionMessage(rejected []string) string {
	if len(rejected) == 0 {
		return "some records had invalid ids or timestamps"
	}
	return strings.Join(rejected, "; ")
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
