package query

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

// Endpoint detail, Errors tab: the error status codes of one endpoint
// (method + route template), the client / server error-rate trend, the
// validation errors of its rejected requests grouped by field, and the
// server exceptions its handlers raised grouped by type and message.
//
// Status codes the endpoint's settings mark as expected are not errors: they
// are left out of the error counts, rates and the status breakdown (the
// requests still count in the totals). Every query reads raw rows: the
// rollups cannot tell an expected status code from another, and the reads
// stay pruned by the (project_id, app_id, hour, environment, path, method)
// sort key of api_requests.
//
// Validation errors come from api_requests.validation_errors (a JSON array
// of {loc, msg, type} sent by the SDKs on a 422). Exceptions are the ERROR
// records the SDKs write to api_logs with logger "apilens.exception" when a
// handler raises: the message is "<ExceptionType>: <message>" and the payload
// the stack trace.

// Limits of the grouped tables.
const (
	maxValidationGroups = 50
	maxExceptionGroups  = 50
)

// exceptionLogger is the logger name the SDKs give the record of an
// exception raised by a request handler.
const exceptionLogger = "apilens.exception"

type endpointErrorsInput struct {
	RangeInput
	Method   string `path:"method" pattern:"^[A-Za-z]{1,16}$" doc:"HTTP method, e.g. GET (case-insensitive)."`
	Path     string `path:"path" minLength:"1" maxLength:"1024" doc:"Route template, URL-encoded as one path segment, e.g. %2Forders%2F%7Bid%7D for /orders/{id}."`
	Consumer string `query:"consumer" maxLength:"256" doc:"Only requests and exceptions from this consumer id; empty means all."`
}

// ErrorSplit counts the requests of a range and their errors, expected
// status codes left out. Exported so Huma reads the fields of the types
// embedding it.
type ErrorSplit struct {
	Requests        uint64  `json:"requests"`
	ClientErrors    uint64  `json:"client_errors" doc:"Requests with a 4xx status code that is not expected for the endpoint."`
	ServerErrors    uint64  `json:"server_errors" doc:"Requests with a 5xx status code that is not expected for the endpoint."`
	ClientErrorRate float64 `json:"client_error_rate" doc:"client_errors / requests, 0 without requests."`
	ServerErrorRate float64 `json:"server_error_rate" doc:"server_errors / requests, 0 without requests."`
}

func (e *ErrorSplit) rates() {
	if e.Requests > 0 {
		e.ClientErrorRate = float64(e.ClientErrors) / float64(e.Requests)
		e.ServerErrorRate = float64(e.ServerErrors) / float64(e.Requests)
	}
}

type endpointErrorsPoint struct {
	TS time.Time `json:"ts" doc:"Start of the bucket."`
	ErrorSplit
}

type endpointStatusCount struct {
	StatusCode uint16    `json:"status_code"`
	Count      uint64    `json:"count"`
	Share      float64   `json:"share" doc:"count / requests of the range."`
	Consumers  uint64    `json:"consumers" doc:"Distinct consumers that got this status code."`
	LastSeen   time.Time `json:"last_seen"`
}

type endpointValidationError struct {
	Loc       string    `json:"loc" doc:"Location of the invalid field, path segments joined with dots, e.g. body.items.0.name."`
	Msg       string    `json:"msg"`
	Type      string    `json:"type"`
	Count     uint64    `json:"count" doc:"Occurrences in the range."`
	Consumers uint64    `json:"consumers" doc:"Distinct consumers that sent the invalid field."`
	LastSeen  time.Time `json:"last_seen"`
}

type endpointException struct {
	ExceptionType string    `json:"exception_type" doc:"Exception class, e.g. ValueError or IllegalStateException; empty when the SDK reported none."`
	Message       string    `json:"message" doc:"Exception message."`
	Count         uint64    `json:"count" doc:"Occurrences in the range."`
	Consumers     uint64    `json:"consumers" doc:"Distinct consumers whose requests raised it."`
	FirstSeen     time.Time `json:"first_seen"`
	LastSeen      time.Time `json:"last_seen"`
	StackTrace    string    `json:"stack_trace" doc:"Stack trace of the latest occurrence."`
	TraceID       string    `json:"trace_id" doc:"Trace of the latest occurrence; empty if it had none."`
}

type endpointErrorsOutput struct {
	Body struct {
		Method           string                    `json:"method"`
		Path             string                    `json:"path"`
		Range            string                    `json:"range"`
		From             time.Time                 `json:"from"`
		To               time.Time                 `json:"to"`
		BucketSeconds    int                       `json:"bucket_seconds"`
		Summary          ErrorSplit                `json:"summary"`
		Points           []endpointErrorsPoint     `json:"points" doc:"One point per bucket of the range, zero-filled."`
		Statuses         []endpointStatusCount     `json:"statuses" doc:"Error status codes (400 and above) by count, expected status codes left out."`
		ValidationErrors []endpointValidationError `json:"validation_errors" doc:"Validation errors of rejected requests grouped by (loc, msg, type), most frequent first (at most 50)."`
		Exceptions       []endpointException       `json:"exceptions" doc:"Server exceptions grouped by (exception_type, message), most frequent first (at most 50)."`
	}
}

func (s *Service) endpointErrors(ctx context.Context, in *endpointErrorsInput) (*endpointErrorsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	rules, err := s.endpointRules(ctx, p.ProjectID)
	if err != nil {
		return nil, err
	}
	method := strings.ToUpper(in.Method)
	seconds := int(w.bucket.Seconds())
	where, args := endpointFilter(p.ProjectID, &endpointRequestsInput{
		RangeInput: in.RangeInput, Path: in.Path, Consumer: in.Consumer,
	}, method, "timestamp", w, true)
	// isError matches a row whose status code is an error not expected for
	// its endpoint; its arguments precede those of where.
	isError, errArgs := "status_code >= 400", []any(nil)
	if pred, pargs := rules.expectedPredicate(); pred != "" {
		isError, errArgs = "status_code >= 400 AND NOT "+pred, pargs
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &endpointErrorsOutput{}
	b := &out.Body
	b.Method, b.Path, b.Range, b.From, b.To, b.BucketSeconds = method, in.Path, w.name, w.from, w.to, seconds

	// The bucket width comes from the fixed ranges map, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(timestamp, INTERVAL %d SECOND) AS t, count(),
		       countIf(status_code < 500 AND %s), countIf(status_code >= 500 AND %s)
		FROM api_requests WHERE %s GROUP BY t ORDER BY t`, seconds, isError, isError, where),
		append(append(append([]any{}, errArgs...), errArgs...), args...)...)
	if err != nil {
		return nil, internalError("endpoint error trend", err)
	}
	got := map[int64]ErrorSplit{}
	for rows.Next() {
		var (
			t  time.Time
			sp ErrorSplit
		)
		if err := rows.Scan(&t, &sp.Requests, &sp.ClientErrors, &sp.ServerErrors); err != nil {
			_ = rows.Close()
			return nil, internalError("endpoint error trend", err)
		}
		got[t.UTC().Unix()] = sp
		b.Summary.Requests += sp.Requests
		b.Summary.ClientErrors += sp.ClientErrors
		b.Summary.ServerErrors += sp.ServerErrors
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("endpoint error trend", err)
	}
	b.Summary.rates()
	b.Points = make([]endpointErrorsPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		sp := got[t.Unix()]
		sp.rates()
		b.Points = append(b.Points, endpointErrorsPoint{TS: t, ErrorSplit: sp})
	}

	if b.Statuses, err = s.endpointStatuses(qctx, where+" AND "+isError, append(args, errArgs...), b.Summary.Requests); err != nil {
		return nil, err
	}
	if b.ValidationErrors, err = s.endpointValidationErrors(qctx, where, args); err != nil {
		return nil, err
	}
	if b.Exceptions, err = s.endpointExceptions(qctx, p.ProjectID, in, method, w); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) endpointStatuses(ctx context.Context, where string, args []any, requests uint64) ([]endpointStatusCount, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT status_code, count() AS n, uniqIf(consumer_id, consumer_id != ''), max(timestamp)
		FROM api_requests WHERE `+where+`
		GROUP BY status_code ORDER BY n DESC, status_code`, args...)
	if err != nil {
		return nil, internalError("endpoint statuses", err)
	}
	defer func() { _ = rows.Close() }()
	out := []endpointStatusCount{}
	for rows.Next() {
		var c endpointStatusCount
		if err := rows.Scan(&c.StatusCode, &c.Count, &c.Consumers, &c.LastSeen); err != nil {
			return nil, internalError("endpoint statuses", err)
		}
		if requests > 0 {
			c.Share = float64(c.Count) / float64(requests)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) endpointValidationErrors(ctx context.Context, where string, args []any) ([]endpointValidationError, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT JSONExtractString(ve, 'loc') AS loc, JSONExtractString(ve, 'msg') AS msg, JSONExtractString(ve, 'type') AS type,
		       count() AS n, uniqIf(consumer_id, consumer_id != ''), max(timestamp)
		FROM api_requests ARRAY JOIN JSONExtractArrayRaw(validation_errors) AS ve
		WHERE `+where+` AND validation_errors != ''
		GROUP BY loc, msg, type ORDER BY n DESC, loc, msg, type LIMIT ?`, append(args, maxValidationGroups)...)
	if err != nil {
		return nil, internalError("endpoint validation errors", err)
	}
	defer func() { _ = rows.Close() }()
	out := []endpointValidationError{}
	for rows.Next() {
		var v endpointValidationError
		if err := rows.Scan(&v.Loc, &v.Msg, &v.Type, &v.Count, &v.Consumers, &v.LastSeen); err != nil {
			return nil, internalError("endpoint validation errors", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Service) endpointExceptions(ctx context.Context, project uuid.UUID, in *endpointErrorsInput, method string, w window) ([]endpointException, error) {
	where, args := tenantFilter(project, in.Env)
	where += " AND endpoint_method = ? AND endpoint_path = ? AND timestamp >= ? AND timestamp < ?" +
		" AND level IN ('ERROR', 'CRITICAL') AND logger_name = ?"
	args = append(args, method, in.Path, w.from, w.to, exceptionLogger)
	if in.Consumer != "" {
		where += " AND consumer_id = ?"
		args = append(args, in.Consumer)
	}
	// The message is "<type>: <message>", so grouping on it groups on both.
	rows, err := s.ch.Query(ctx, `
		SELECT message, count() AS n, uniqIf(consumer_id, consumer_id != ''), min(timestamp), max(timestamp),
		       argMax(payload, timestamp), argMax(trace_id, timestamp)
		FROM api_logs WHERE `+where+`
		GROUP BY message ORDER BY n DESC, message LIMIT ?`, append(args, maxExceptionGroups)...)
	if err != nil {
		return nil, internalError("endpoint exceptions", err)
	}
	defer func() { _ = rows.Close() }()
	out := []endpointException{}
	for rows.Next() {
		var (
			e   endpointException
			msg string
		)
		if err := rows.Scan(&msg, &e.Count, &e.Consumers, &e.FirstSeen, &e.LastSeen, &e.StackTrace, &e.TraceID); err != nil {
			return nil, internalError("endpoint exceptions", err)
		}
		e.ExceptionType, e.Message = splitException(msg)
		out = append(out, e)
	}
	return out, rows.Err()
}

// splitException splits the "<type>: <message>" text the SDKs log for an
// exception. The type is the part before the first colon when it reads as
// a (possibly qualified) class name; otherwise the whole text is the
// message.
func splitException(s string) (typ, msg string) {
	s = strings.TrimSpace(s)
	i := strings.IndexByte(s, ':')
	if i <= 0 || !isClassName(s[:i]) {
		return "", s
	}
	return s[:i], strings.TrimSpace(s[i+1:])
}

func isClassName(s string) bool {
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '.' && r != '$' {
			return false
		}
	}
	return true
}
