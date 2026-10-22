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

type accepted struct {
	Accepted int `json:"accepted"`
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
		Requests []requestRecord `json:"requests"`
	}
	if aerr = e.decodeJSON(w, r, &body); aerr == nil {
		aerr = e.checkCount(len(body.Requests))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	slugs, idents := make([]string, len(body.Requests)), make([]string, len(body.Requests))
	for i, rec := range body.Requests {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	apps, aerr := e.resolveApps(r.Context(), p, slugs, idents, false)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.RequestRow, 0, len(body.Requests))
	for i, rec := range body.Requests {
		if !validTimestamp(rec.Timestamp.Time, now) {
			e.fail(w, signal, errValidation("requests[%d].timestamp is missing or out of range", i))
			return
		}
		method := strings.ToUpper(strings.TrimSpace(rec.Method))
		path := short(rec.Path)
		if method == "" || path == "" {
			e.fail(w, signal, errValidation("requests[%d]: method and path are required", i))
			return
		}
		rows = append(rows, pipeline.RequestRow{
			ProjectID:       p.ProjectID,
			AppID:           apps[strings.TrimSpace(rec.AppID)],
			Environment:     environment(rec.Environment),
			Timestamp:       rec.Timestamp.Time,
			Method:          truncate(method, 16),
			Path:            path,
			RawPath:         truncate(strings.TrimSpace(rec.RawPath), maxPayloadChars),
			StatusCode:      clampStatus(rec.StatusCode),
			ResponseTimeMs:  nonNegative(rec.ResponseTimeMs),
			RequestSize:     sizeOf(rec.RequestSize),
			ResponseSize:    sizeOf(rec.ResponseSize),
			IPAddress:       truncate(strings.TrimSpace(rec.IPAddress), 64),
			UserAgent:       short(rec.UserAgent),
			ConsumerID:      truncate(strings.TrimSpace(rec.ConsumerID), 256),
			ConsumerName:    truncate(strings.TrimSpace(rec.ConsumerName), 256),
			ConsumerGroup:   truncate(strings.TrimSpace(rec.ConsumerGroup), 256),
			RequestPayload:  truncate(rec.RequestPayload, maxPayloadChars),
			ResponsePayload: truncate(rec.ResponsePayload, maxPayloadChars),
			RequestHeaders:  truncate(rec.RequestHeaders, maxPayloadChars),
			ResponseHeaders: truncate(rec.ResponseHeaders, maxPayloadChars),
			BaseURL:         short(rec.BaseURL),
			TraceID:         hexID(rec.TraceID, traceIDHexLen),
			SpanID:          hexID(rec.SpanID, spanIDHexLen),
			Release:         release(rec.Release),
			Commit:          commit(rec.Commit),
		})
	}
	if err := e.sink.SubmitRequests(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	e.ok(w, signal, len(rows))
}

func (e *Edge) handleLogs(w http.ResponseWriter, r *http.Request) {
	const signal = "logs"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Logs []logRecord `json:"logs"`
	}
	if aerr = e.decodeJSON(w, r, &body); aerr == nil {
		aerr = e.checkCount(len(body.Logs))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	slugs, idents := make([]string, len(body.Logs)), make([]string, len(body.Logs))
	for i, rec := range body.Logs {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	apps, aerr := e.resolveApps(r.Context(), p, slugs, idents, false)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.LogRow, 0, len(body.Logs))
	for i, rec := range body.Logs {
		if !validTimestamp(rec.Timestamp.Time, now) {
			e.fail(w, signal, errValidation("logs[%d].timestamp is missing or out of range", i))
			return
		}
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
			Payload:        truncate(rec.Payload, maxLogPayloadChars),
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
	e.ok(w, signal, len(rows))
}

func (e *Edge) handleSpans(w http.ResponseWriter, r *http.Request) {
	const signal = "spans"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Spans []spanRecord `json:"spans"`
	}
	if aerr = e.decodeJSON(w, r, &body); aerr == nil {
		aerr = e.checkCount(len(body.Spans))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	slugs, idents := make([]string, len(body.Spans)), make([]string, len(body.Spans))
	for i, rec := range body.Spans {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	apps, aerr := e.resolveApps(r.Context(), p, slugs, idents, false)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.SpanRow, 0, len(body.Spans))
	for i, rec := range body.Spans {
		traceID, spanID := hexID(rec.TraceID, traceIDHexLen), hexID(rec.SpanID, spanIDHexLen)
		if traceID == "" || spanID == "" {
			e.fail(w, signal, errValidation("spans[%d]: trace_id and span_id must be W3C hex ids", i))
			return
		}
		if !validTimestamp(rec.Timestamp.Time, now) {
			e.fail(w, signal, errValidation("spans[%d].timestamp is missing or out of range", i))
			return
		}
		status := "ok"
		if strings.EqualFold(strings.TrimSpace(rec.Status), "error") {
			status = "error"
		}
		kind := strings.ToLower(strings.TrimSpace(rec.Kind))
		if kind == "" {
			kind = "internal"
		}
		rows = append(rows, pipeline.SpanRow{
			ProjectID:    p.ProjectID,
			AppID:        apps[strings.TrimSpace(rec.AppID)],
			Environment:  environment(rec.Environment),
			Timestamp:    rec.Timestamp.Time,
			TraceID:      traceID,
			SpanID:       spanID,
			ParentSpanID: hexID(rec.ParentSpanID, spanIDHexLen),
			Name:         short(rec.Name),
			Kind:         truncate(kind, 32),
			ServiceName:  short(rec.ServiceName),
			DurationMs:   nonNegative(rec.DurationMs),
			Status:       status,
			StatusCode:   clampStatus(rec.StatusCode),
			Attributes:   attributes(rec.Attributes),
			Release:      release(rec.Release),
			Commit:       commit(rec.Commit),
		})
	}
	if err := e.sink.SubmitSpans(r.Context(), rows); err != nil {
		e.records.WithLabelValues(signal, "failed").Add(float64(len(rows)))
		e.fail(w, signal, e.submitError(err))
		return
	}
	e.ok(w, signal, len(rows))
}

func (e *Edge) handleDeploys(w http.ResponseWriter, r *http.Request) {
	const signal = "deploys"
	p, aerr := e.authenticate(r)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	var body struct {
		Deploys []deployRecord `json:"deploys"`
	}
	if aerr = e.decodeJSON(w, r, &body); aerr == nil {
		aerr = e.checkCount(len(body.Deploys))
	}
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}
	slugs, idents := make([]string, len(body.Deploys)), make([]string, len(body.Deploys))
	for i, rec := range body.Deploys {
		slugs[i], idents[i] = rec.ProjectSlug, rec.AppID
	}
	apps, aerr := e.resolveApps(r.Context(), p, slugs, idents, true)
	if aerr != nil {
		e.fail(w, signal, aerr)
		return
	}

	now := e.now()
	rows := make([]pipeline.DeployRow, 0, len(body.Deploys))
	for i, rec := range body.Deploys {
		rel := release(rec.Release)
		if rel == "" {
			e.fail(w, signal, errValidation("deploys[%d].release is required", i))
			return
		}
		at := rec.DeployedAt.Time
		if at.IsZero() {
			at = now.UTC()
		} else if !validTimestamp(at, now) {
			e.fail(w, signal, errValidation("deploys[%d].deployed_at is out of range", i))
			return
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
	e.ok(w, signal, len(rows))
}

func (e *Edge) ok(w http.ResponseWriter, signal string, n int) {
	e.records.WithLabelValues(signal, "accepted").Add(float64(n))
	e.batches.WithLabelValues(signal, "200").Inc()
	writeJSON(w, http.StatusOK, accepted{Accepted: n})
}
