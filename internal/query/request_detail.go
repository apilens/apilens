package query

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Request detail: everything the request drawer shows for one api_requests
// row in a single call — the record, its headers and bodies exactly as stored
// (redaction and truncation markers untouched; the UI parses the JSON), its
// validation errors, and the spans and logs of its trace.
//
// A request is identified by (timestamp, trace_id, span_id), encoded as an
// opaque id that the request log returns on each row.

// requestID is the identity of one api_requests row.
type requestID struct {
	ms      int64 // timestamp, Unix milliseconds
	traceID string
	spanID  string
}

func (id requestID) encode() string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(id.ms, 10) + ":" + id.traceID + ":" + id.spanID))
}

func decodeRequestID(s string) (requestID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return requestID{}, err
	}
	parts := strings.Split(string(raw), ":")
	if len(parts) != 3 {
		return requestID{}, errors.New("malformed request id")
	}
	ms, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return requestID{}, err
	}
	return requestID{ms: ms, traceID: parts[1], spanID: parts[2]}, nil
}

type requestDetailInput struct {
	ProjectInput
	ID string `path:"id" maxLength:"256" doc:"Request id from the id field of a request log row."`
}

// requestDetail is a request log row plus the columns only the drawer shows.
// The row fields are spelled out (not embedded) so the OpenAPI schema
// carries them.
type requestDetail struct {
	ID               string                   `json:"id" doc:"Opaque request id, as in the request log."`
	Timestamp        time.Time                `json:"timestamp" doc:"When the request was received."`
	AppID            string                   `json:"app_id" format:"uuid" doc:"The app that served the request."`
	Method           string                   `json:"method" doc:"HTTP method."`
	Path             string                   `json:"path" doc:"Route template the request matched, e.g. /orders/{id}."`
	RawPath          string                   `json:"raw_path" doc:"Requested path with its query string, as the SDK sent it after redaction."`
	StatusCode       uint16                   `json:"status_code" doc:"HTTP status code."`
	ResponseTimeMs   float64                  `json:"response_time_ms" doc:"Response time, in milliseconds."`
	RequestSize      uint64                   `json:"request_size" doc:"Request body size in bytes."`
	ResponseSize     uint64                   `json:"response_size" doc:"Response body size in bytes."`
	Environment      string                   `json:"environment" doc:"Environment the app reported from."`
	IPAddress        string                   `json:"ip_address" doc:"Client IP address; empty when not captured."`
	ConsumerID       string                   `json:"consumer_id" doc:"Consumer id the SDK reported; empty when none."`
	ConsumerName     string                   `json:"consumer_name" doc:"Consumer name the SDK reported; empty when none."`
	ConsumerGroup    string                   `json:"consumer_group" doc:"Consumer group the SDK reported; empty when none."`
	Sampled          bool                     `json:"sampled" doc:"False when the SDK sampled the request out: a base record without headers or bodies."`
	TraceID          string                   `json:"trace_id" doc:"W3C trace id; empty when the request had none."`
	SpanID           string                   `json:"span_id" doc:"Server span id of the request in its trace; empty when none."`
	UserAgent        string                   `json:"user_agent" doc:"User-Agent header; empty when not captured."`
	BaseURL          string                   `json:"base_url" doc:"Scheme and host the request was made to; empty when not captured."`
	Release          string                   `json:"release" doc:"Release of the app that served the request; empty when not configured."`
	Commit           string                   `json:"commit" doc:"Commit of the app that served the request; empty when not configured."`
	RequestHeaders   string                   `json:"request_headers" doc:"Request headers as stored: a JSON object text, empty when not captured. Redaction and truncation markers are kept."`
	ResponseHeaders  string                   `json:"response_headers" doc:"Response headers as stored: a JSON object text, empty when not captured."`
	RequestBody      string                   `json:"request_body" doc:"Request body as stored (often JSON text), empty when not captured. Redaction and truncation markers are kept."`
	ResponseBody     string                   `json:"response_body" doc:"Response body as stored (often JSON text), empty when not captured."`
	Attributes       map[string]string        `json:"attributes" doc:"Custom request attributes."`
	ValidationErrors []requestValidationError `json:"validation_errors" nullable:"false" doc:"Field errors of a rejected request (usually a 422); empty when there were none."`
}

type requestValidationError struct {
	Loc  string `json:"loc" doc:"Location of the invalid field, path segments joined with dots, e.g. body.qty."`
	Msg  string `json:"msg" doc:"Error message the framework reported."`
	Type string `json:"type" doc:"Error type the framework reported, e.g. missing or value_error."`
}

type requestDetailOutput struct {
	Body struct {
		Request requestDetail `json:"request" doc:"The request record."`
		Spans   []spanOut     `json:"spans" doc:"Spans of the request's trace, oldest first (at most 2000); empty without a trace id."`
		Logs    []traceLog    `json:"logs" doc:"Logs of the request's trace, oldest first (at most 500); empty without a trace id."`
	}
}

func (s *Service) requestDetail(ctx context.Context, in *requestDetailInput) (*requestDetailOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	id, err := decodeRequestID(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("request not found")
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	var (
		out        = &requestDetailOutput{}
		r          = &out.Body.Request
		app        uuid.UUID
		sampled    uint8
		validation string
	)
	err = s.ch.QueryRow(qctx, `
		SELECT timestamp, app_id, method, path, raw_path, status_code, response_time_ms, request_size, response_size,
		       environment, ip_address, consumer_id, consumer_name, consumer_group, sampled, trace_id, span_id,
		       user_agent, base_url, release, commit, request_headers, response_headers, request_payload, response_payload,
		       attributes, validation_errors
		FROM api_requests
		WHERE project_id = ? AND timestamp = fromUnixTimestamp64Milli(?, 'UTC') AND trace_id = ? AND span_id = ?
		LIMIT 1`, p.ProjectID, id.ms, id.traceID, id.spanID).Scan(
		&r.Timestamp, &app, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs, &r.RequestSize, &r.ResponseSize,
		&r.Environment, &r.IPAddress, &r.ConsumerID, &r.ConsumerName, &r.ConsumerGroup, &sampled, &r.TraceID, &r.SpanID,
		&r.UserAgent, &r.BaseURL, &r.Release, &r.Commit, &r.RequestHeaders, &r.ResponseHeaders, &r.RequestBody, &r.ResponseBody,
		&r.Attributes, &validation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, huma.Error404NotFound("request not found")
	}
	if err != nil {
		return nil, internalError("request detail", err)
	}
	r.ID = in.ID
	r.AppID, r.Sampled = app.String(), sampled != 0
	r.Timestamp = r.Timestamp.In(time.UTC)
	if r.Attributes == nil {
		r.Attributes = map[string]string{}
	}
	r.ValidationErrors = parseRequestValidationErrors(validation)

	out.Body.Spans, out.Body.Logs = []spanOut{}, []traceLog{}
	if r.TraceID != "" {
		out.Body.Spans, out.Body.Logs, err = s.traceSpansAndLogs(qctx, p.ProjectID, r.TraceID)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// parseRequestValidationErrors reads the stored validation_errors JSON array;
// anything unreadable yields no errors rather than failing the drawer.
func parseRequestValidationErrors(s string) []requestValidationError {
	out := []requestValidationError{}
	if strings.TrimSpace(s) == "" {
		return out
	}
	if err := json.Unmarshal([]byte(s), &out); err != nil || out == nil {
		return []requestValidationError{}
	}
	return out
}
