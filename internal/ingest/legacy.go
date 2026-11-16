package ingest

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/pipeline"
)

// The v1 SDK wire format (apilenss <= 0.4, apilens-js-sdk, apilens-java-sdk).
// Field names and defaults match apps/ingest/app/schemas.py in legacy-v1.

type requestRecord struct {
	ProjectSlug     string   `json:"project_slug"`
	AppID           string   `json:"app_id"`
	Timestamp       flexTime `json:"timestamp"`
	Environment     string   `json:"environment"`
	Method          string   `json:"method"`
	Path            string   `json:"path"`
	RawPath         string   `json:"raw_path"`
	StatusCode      int      `json:"status_code"`
	ResponseTimeMs  float64  `json:"response_time_ms"`
	RequestSize     int64    `json:"request_size"`
	ResponseSize    int64    `json:"response_size"`
	IPAddress       string   `json:"ip_address"`
	UserAgent       string   `json:"user_agent"`
	ConsumerID      string   `json:"consumer_id"`
	ConsumerName    string   `json:"consumer_name"`
	ConsumerGroup   string   `json:"consumer_group"`
	RequestPayload  string   `json:"request_payload"`
	ResponsePayload string   `json:"response_payload"`
	RequestHeaders  string   `json:"request_headers"`
	ResponseHeaders string   `json:"response_headers"`
	BaseURL         string   `json:"base_url"`
	TraceID         string   `json:"trace_id"`
	SpanID          string   `json:"span_id"`
	Release         string   `json:"release"`
	Commit          string   `json:"commit"`
	// M3 SDK fields; older SDKs omit them.
	Sampled          *bool                      `json:"sampled"`
	Attributes       map[string]json.RawMessage `json:"attributes"`
	ValidationErrors json.RawMessage            `json:"validation_errors"`
}

type logRecord struct {
	ProjectSlug    string                     `json:"project_slug"`
	AppID          string                     `json:"app_id"`
	Timestamp      flexTime                   `json:"timestamp"`
	Environment    string                     `json:"environment"`
	Level          string                     `json:"level"`
	Message        string                     `json:"message"`
	LoggerName     string                     `json:"logger_name"`
	EndpointMethod string                     `json:"endpoint_method"`
	EndpointPath   string                     `json:"endpoint_path"`
	StatusCode     int                        `json:"status_code"`
	ConsumerID     string                     `json:"consumer_id"`
	ConsumerName   string                     `json:"consumer_name"`
	ConsumerGroup  string                     `json:"consumer_group"`
	TraceID        string                     `json:"trace_id"`
	SpanID         string                     `json:"span_id"`
	Payload        string                     `json:"payload"`
	Attributes     map[string]json.RawMessage `json:"attributes"`
	Release        string                     `json:"release"`
	Commit         string                     `json:"commit"`
}

type spanRecord struct {
	ProjectSlug  string                     `json:"project_slug"`
	AppID        string                     `json:"app_id"`
	Timestamp    flexTime                   `json:"timestamp"`
	Environment  string                     `json:"environment"`
	TraceID      string                     `json:"trace_id"`
	SpanID       string                     `json:"span_id"`
	ParentSpanID string                     `json:"parent_span_id"`
	Name         string                     `json:"name"`
	Kind         string                     `json:"kind"`
	ServiceName  string                     `json:"service_name"`
	DurationMs   float64                    `json:"duration_ms"`
	Status       string                     `json:"status"`
	StatusCode   int                        `json:"status_code"`
	Attributes   map[string]json.RawMessage `json:"attributes"`
	Release      string                     `json:"release"`
	Commit       string                     `json:"commit"`
	// M5 fields; older SDKs omit them.
	StatusMessage string            `json:"status_message"`
	Events        []spanEventRecord `json:"events"`
	Links         []spanLinkRecord  `json:"links"`
}

type deployRecord struct {
	ProjectSlug string   `json:"project_slug"`
	AppID       string   `json:"app_id"`
	Environment string   `json:"environment"`
	Release     string   `json:"release"`
	Commit      string   `json:"commit"`
	URL         string   `json:"url"`
	DeployedAt  flexTime `json:"deployed_at"`
}

// accepted is the 200 answer of a batch call. rejected lists the apps whose
// records were refused; invalid counts the records refused on their own
// (bad field, timestamp or id) and errors names up to maxRecordErrors of
// them by their index in the body.
type accepted struct {
	Accepted int           `json:"accepted"`
	Rejected []rejectedApp `json:"rejected,omitempty"`
	Invalid  int           `json:"invalid,omitempty"`
	Errors   []recordError `json:"errors,omitempty"`
}

func (e *Edge) checkCount(n int) *apiError {
	if n == 0 {
		return errValidation("at least one record is required")
	}
	if n > e.cfg.MaxRecordsPerRequest {
		return errValidation("at most %d records per request (got %d)", e.cfg.MaxRecordsPerRequest, n)
	}
	return nil
}

func (e *Edge) handleRequests(w http.ResponseWriter, r *http.Request) {
	const signal = "requests"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Requests []json.RawMessage `json:"requests"`
	}
	size, aerr := e.decodeBatch(w, r, &body)
	if aerr == nil {
		aerr = e.checkCount(len(body.Requests))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	now := e.now()
	inv := &invalidRecords{}
	recs := parseRecords(body.Requests, "requests", func(rec requestRecord) string { return rec.AppID }, func(rec requestRecord) string {
		if !validTimestamp(rec.Timestamp.Time, now) {
			return ".timestamp is missing or out of range"
		}
		if strings.TrimSpace(rec.Method) == "" || short(rec.Path) == "" {
			return ": method and path are required"
		}
		return ""
	}, inv)
	e.rejectInvalid(r.Context(), p.ProjectID, signal, inv, t)
	if len(recs) == 0 {
		e.answer(w, signal, 0, nil, inv)
		return
	}
	slugs, idents := make([]string, len(recs)), make([]string, len(recs))
	for i, rec := range recs {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	if aerr := e.admit(r.Context(), p, len(recs), size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, idents, t)
		e.fail(w, signal, aerr)
		return
	}
	envs := recordEnvs(recs, func(rec requestRecord) string { return rec.Environment })
	batch, aerr := e.resolveBatch(r.Context(), signal, p, slugs, idents, envs, false, t)
	if aerr == nil {
		recs = filterRecords(recs, func(rec requestRecord) string { return rec.AppID }, batch)
		aerr = e.redactRequests(r.Context(), p.ProjectID, batch.apps, recs, t)
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	apps := batch.apps
	e.capRequests(r.Context(), apps, recs, t)

	rows := make([]pipeline.RequestRow, 0, len(recs))
	for _, rec := range recs {
		method := strings.ToUpper(strings.TrimSpace(rec.Method))
		path := short(rec.Path)
		rows = append(rows, pipeline.RequestRow{
			ProjectID:        p.ProjectID,
			AppID:            apps[strings.TrimSpace(rec.AppID)],
			Environment:      environment(rec.Environment),
			Timestamp:        rec.Timestamp.Time,
			Method:           truncate(method, 16),
			Path:             path,
			RawPath:          truncate(strings.TrimSpace(rec.RawPath), maxPayloadChars),
			StatusCode:       clampStatus(rec.StatusCode),
			ResponseTimeMs:   nonNegative(rec.ResponseTimeMs),
			RequestSize:      sizeOf(rec.RequestSize),
			ResponseSize:     sizeOf(rec.ResponseSize),
			IPAddress:        truncate(strings.TrimSpace(rec.IPAddress), 64),
			UserAgent:        short(rec.UserAgent),
			ConsumerID:       truncate(strings.TrimSpace(rec.ConsumerID), 256),
			ConsumerName:     truncate(strings.TrimSpace(rec.ConsumerName), 256),
			ConsumerGroup:    truncate(strings.TrimSpace(rec.ConsumerGroup), 256),
			RequestPayload:   rec.RequestPayload, // capped by capRequests
			ResponsePayload:  rec.ResponsePayload,
			RequestHeaders:   rec.RequestHeaders,
			ResponseHeaders:  rec.ResponseHeaders,
			BaseURL:          short(rec.BaseURL),
			TraceID:          hexID(rec.TraceID, traceIDHexLen),
			SpanID:           hexID(rec.SpanID, spanIDHexLen),
			Release:          release(rec.Release),
			Commit:           commit(rec.Commit),
			Sampled:          sampled(rec.Sampled),
			Attributes:       attributesN(rec.Attributes, maxRequestAttributes),
			ValidationErrors: requestValidationErrors(rec.StatusCode, rec.ValidationErrors, rec.ResponsePayload),
		})
	}
	if err := e.sink.SubmitRequests(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.answer(w, signal, len(rows), batch, inv)
}

func (e *Edge) handleLogs(w http.ResponseWriter, r *http.Request) {
	const signal = "logs"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Logs []json.RawMessage `json:"logs"`
	}
	size, aerr := e.decodeBatch(w, r, &body)
	if aerr == nil {
		aerr = e.checkCount(len(body.Logs))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	now := e.now()
	inv := &invalidRecords{}
	recs := parseRecords(body.Logs, "logs", func(rec logRecord) string { return rec.AppID }, func(rec logRecord) string {
		if !validTimestamp(rec.Timestamp.Time, now) {
			return ".timestamp is missing or out of range"
		}
		return ""
	}, inv)
	e.rejectInvalid(r.Context(), p.ProjectID, signal, inv, t)
	if len(recs) == 0 {
		e.answer(w, signal, 0, nil, inv)
		return
	}
	slugs, idents := make([]string, len(recs)), make([]string, len(recs))
	for i, rec := range recs {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	if aerr := e.admit(r.Context(), p, len(recs), size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, idents, t)
		e.fail(w, signal, aerr)
		return
	}
	envs := recordEnvs(recs, func(rec logRecord) string { return rec.Environment })
	batch, aerr := e.resolveBatch(r.Context(), signal, p, slugs, idents, envs, false, t)
	if aerr == nil {
		recs = filterRecords(recs, func(rec logRecord) string { return rec.AppID }, batch)
		aerr = e.redactLogs(r.Context(), p.ProjectID, batch.apps, recs, t)
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	apps := batch.apps

	rows := make([]pipeline.LogRow, 0, len(recs))
	for _, rec := range recs {
		rows = append(rows, pipeline.LogRow{
			ProjectID:      p.ProjectID,
			AppID:          apps[strings.TrimSpace(rec.AppID)],
			Environment:    environment(rec.Environment),
			Timestamp:      rec.Timestamp.Time,
			Level:          logLevel(rec.Level),
			Message:        truncate(rec.Message, maxLogMessageChars),
			LoggerName:     short(rec.LoggerName),
			EndpointMethod: truncate(strings.ToUpper(strings.TrimSpace(rec.EndpointMethod)), 16),
			EndpointPath:   short(rec.EndpointPath),
			StatusCode:     clampStatus(rec.StatusCode),
			ConsumerID:     truncate(strings.TrimSpace(rec.ConsumerID), 256),
			ConsumerName:   truncate(strings.TrimSpace(rec.ConsumerName), 256),
			ConsumerGroup:  truncate(strings.TrimSpace(rec.ConsumerGroup), 256),
			TraceID:        hexID(rec.TraceID, traceIDHexLen),
			SpanID:         hexID(rec.SpanID, spanIDHexLen),
			Payload:        truncateHeadTail(rec.Payload, maxLogPayloadChars),
			Attributes:     attributes(rec.Attributes),
			Release:        release(rec.Release),
			Commit:         commit(rec.Commit),
		})
	}
	if err := e.sink.SubmitLogs(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.answer(w, signal, len(rows), batch, inv)
}

func (e *Edge) handleSpans(w http.ResponseWriter, r *http.Request) {
	const signal = "spans"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Spans []json.RawMessage `json:"spans"`
	}
	size, aerr := e.decodeBatch(w, r, &body)
	if aerr == nil {
		aerr = e.checkCount(len(body.Spans))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	now := e.now()
	inv := &invalidRecords{}
	recs := parseRecords(body.Spans, "spans", func(rec spanRecord) string { return rec.AppID }, func(rec spanRecord) string {
		if hexID(rec.TraceID, traceIDHexLen) == "" || hexID(rec.SpanID, spanIDHexLen) == "" {
			return ": trace_id and span_id must be W3C hex ids"
		}
		if !validTimestamp(rec.Timestamp.Time, now) {
			return ".timestamp is missing or out of range"
		}
		return ""
	}, inv)
	e.rejectInvalid(r.Context(), p.ProjectID, signal, inv, t)
	if len(recs) == 0 {
		e.answer(w, signal, 0, nil, inv)
		return
	}
	slugs, idents := make([]string, len(recs)), make([]string, len(recs))
	for i, rec := range recs {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	if aerr := e.admit(r.Context(), p, len(recs), size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, idents, t)
		e.fail(w, signal, aerr)
		return
	}
	envs := recordEnvs(recs, func(rec spanRecord) string { return rec.Environment })
	batch, aerr := e.resolveBatch(r.Context(), signal, p, slugs, idents, envs, false, t)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	recs = filterRecords(recs, func(rec spanRecord) string { return rec.AppID }, batch)
	apps := batch.apps

	rows := make([]pipeline.SpanRow, 0, len(recs))
	for _, rec := range recs {
		traceID, spanID := hexID(rec.TraceID, traceIDHexLen), hexID(rec.SpanID, spanIDHexLen)
		status := "ok"
		if strings.EqualFold(strings.TrimSpace(rec.Status), "error") {
			status = "error"
		}
		kind := strings.ToLower(strings.TrimSpace(rec.Kind))
		if kind == "" {
			kind = "internal"
		}
		appID := apps[strings.TrimSpace(rec.AppID)]
		events, eventsCut := spanEvents(rec.Events, rec.Timestamp.Time)
		links, linksCut := spanLinks(rec.Links)
		if eventsCut || linksCut {
			e.truncated.WithLabelValues(FieldSpanEvents).Inc()
			t.app(appID).Truncated++
		}
		rows = append(rows, pipeline.SpanRow{
			ProjectID:     p.ProjectID,
			AppID:         appID,
			Environment:   environment(rec.Environment),
			Timestamp:     rec.Timestamp.Time,
			TraceID:       traceID,
			SpanID:        spanID,
			ParentSpanID:  hexID(rec.ParentSpanID, spanIDHexLen),
			Name:          short(rec.Name),
			Kind:          truncate(kind, 32),
			ServiceName:   short(rec.ServiceName),
			DurationMs:    nonNegative(rec.DurationMs),
			Status:        status,
			StatusCode:    clampStatus(rec.StatusCode),
			Attributes:    attributes(rec.Attributes),
			Release:       release(rec.Release),
			Commit:        commit(rec.Commit),
			StatusMessage: truncate(strings.TrimSpace(rec.StatusMessage), maxSpanStatusMessageChars),
			Events:        events,
			Links:         links,
		})
	}
	if err := e.sink.SubmitSpans(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.answer(w, signal, len(rows), batch, inv)
}

func (e *Edge) handleDeploys(w http.ResponseWriter, r *http.Request) {
	const signal = "deploys"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Deploys []json.RawMessage `json:"deploys"`
	}
	size, aerr := e.decodeBatch(w, r, &body)
	if aerr == nil {
		aerr = e.checkCount(len(body.Deploys))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	t := tally{}
	defer e.flushStats(r.Context(), t)
	now := e.now()
	inv := &invalidRecords{}
	recs := parseRecords(body.Deploys, "deploys", func(rec deployRecord) string { return rec.AppID }, func(rec deployRecord) string {
		if release(rec.Release) == "" {
			return ".release is required"
		}
		if at := rec.DeployedAt.Time; !at.IsZero() && !validTimestamp(at, now) {
			return ".deployed_at is out of range"
		}
		return ""
	}, inv)
	e.rejectInvalid(r.Context(), p.ProjectID, signal, inv, t)
	if len(recs) == 0 {
		e.answer(w, signal, 0, nil, inv)
		return
	}
	slugs, idents := make([]string, len(recs)), make([]string, len(recs))
	for i, rec := range recs {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	if aerr := e.admit(r.Context(), p, len(recs), size, t); aerr != nil {
		e.rejectRecords(r.Context(), p.ProjectID, signal, idents, t)
		e.fail(w, signal, aerr)
		return
	}
	envs := recordEnvs(recs, func(rec deployRecord) string { return rec.Environment })
	batch, aerr := e.resolveBatch(r.Context(), signal, p, slugs, idents, envs, true, t)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	recs = filterRecords(recs, func(rec deployRecord) string { return rec.AppID }, batch)
	apps := batch.apps

	rows := make([]pipeline.DeployRow, 0, len(recs))
	for _, rec := range recs {
		rel := release(rec.Release)
		at := rec.DeployedAt.Time
		if at.IsZero() {
			at = now.UTC()
		}
		appID := uuid.Nil
		if id := strings.TrimSpace(rec.AppID); id != "" {
			appID = apps[id]
		}
		rows = append(rows, pipeline.DeployRow{
			ProjectID:   p.ProjectID,
			AppID:       appID,
			Environment: environment(rec.Environment),
			Release:     rel,
			Commit:      commit(rec.Commit),
			URL:         short(rec.URL),
			DeployedAt:  at,
		})
	}
	if err := e.sink.SubmitDeploys(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	for _, row := range rows {
		t.accept(row.AppID, row.Environment)
	}
	e.answer(w, signal, len(rows), batch, inv)
}
