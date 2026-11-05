package query

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Request log: the raw api_requests rows of a range, newest first, with the
// Apitally filter set and keyset pagination on (timestamp, trace_id).
//
// Every filter narrows the result (AND). The project, range and environment
// predicates come first so the (project_id, app_id, hour, environment, path,
// method) sort key prunes the scan; the substring filters run on what is
// left.
//
// Benchmark (issue #576, budget 2 s on 10M rows): 10M rows of 24h traffic
// with request and response bodies, range=24h, single local ClickHouse
// (colima, 2 vCPU / 4 GB), a new search text per call: payload_contains
// p50 0.95 s / max 1.15 s, url_contains p50 0.35 s / max 0.44 s. Within
// budget, so no tokenbf_v1 skip index on the payload columns (it would not
// serve ILIKE anyway). Reproduce with APILENS_BENCH=1 go test -tags
// integration -run TestRequestLogPayloadBenchmark.

// maxRequestsPage is the largest page of the request log.
const maxRequestsPage = 200

// maxStatusTerms bounds the terms of a status filter.
const maxStatusTerms = 20

type requestsInput struct {
	RangeInput
	ConsumerID      string  `query:"consumer_id" maxLength:"256" doc:"Only requests from this consumer id."`
	ConsumerGroup   string  `query:"consumer_group" maxLength:"256" doc:"Only requests from consumers of this group."`
	IP              string  `query:"ip" maxLength:"64" doc:"Only requests from this client IP address (exact match)."`
	Method          string  `query:"method" pattern:"^[A-Za-z]{1,16}$" doc:"Only requests with this HTTP method (case-insensitive)."`
	Path            string  `query:"path" maxLength:"1024" doc:"Route template, e.g. /orders/{id}."`
	URLContains     string  `query:"url_contains" maxLength:"1024" doc:"Only requests whose raw URL path (with query string) contains this text, ignoring case."`
	PayloadContains string  `query:"payload_contains" maxLength:"1024" doc:"Only requests whose request or response body contains this text, ignoring case. Bodies are only kept for sampled requests with body capture on."`
	RequestSizeMin  uint64  `query:"request_size_min" doc:"Only requests with a request body of at least this many bytes."`
	RequestSizeMax  uint64  `query:"request_size_max" doc:"Only requests with a request body of at most this many bytes."`
	ResponseSizeMin uint64  `query:"response_size_min" doc:"Only requests with a response body of at least this many bytes."`
	ResponseSizeMax uint64  `query:"response_size_max" doc:"Only requests with a response body of at most this many bytes."`
	Status          string  `query:"status" maxLength:"256" default:"all" doc:"Comma-separated status codes (404), classes (4xx) and inclusive ranges (500-503); a request matches when its status matches any term. all (the default) means every status."`
	LatencyMin      float64 `query:"latency_min" minimum:"0" doc:"Only requests that took at least this many milliseconds."`
	LatencyMax      float64 `query:"latency_max" minimum:"0" doc:"Only requests that took at most this many milliseconds."`
	Sampled         string  `query:"sampled" enum:"true,false" doc:"Only requests the SDK kept in full (true) or sampled out to a base record (false); omitted means both."`
	TraceID         string  `query:"trace_id" maxLength:"64" doc:"Only requests of this trace."`
	Cursor          string  `query:"cursor" maxLength:"256" doc:"next_cursor of the previous page; omitted means the first page."`
	Limit           int     `query:"limit" minimum:"1" maximum:"200" default:"100" doc:"Page size."`

	// Which upper bounds were sent: their zero value is a real bound.
	hasRequestSizeMax, hasResponseSizeMax, hasLatencyMax bool
}

// Resolve records which upper bounds the request sent.
func (in *requestsInput) Resolve(ctx huma.Context) []error {
	u := ctx.URL()
	q := u.Query()
	in.hasRequestSizeMax = q.Has("request_size_max")
	in.hasResponseSizeMax = q.Has("response_size_max")
	in.hasLatencyMax = q.Has("latency_max")
	return nil
}

type requestRow struct {
	Timestamp      time.Time `json:"timestamp"`
	AppID          string    `json:"app_id" format:"uuid"`
	Method         string    `json:"method"`
	Path           string    `json:"path"`
	RawPath        string    `json:"raw_path"`
	StatusCode     uint16    `json:"status_code"`
	ResponseTimeMs float64   `json:"response_time_ms"`
	RequestSize    uint64    `json:"request_size" doc:"Request body size in bytes."`
	ResponseSize   uint64    `json:"response_size" doc:"Response body size in bytes."`
	Environment    string    `json:"environment"`
	IPAddress      string    `json:"ip_address"`
	ConsumerID     string    `json:"consumer_id"`
	ConsumerName   string    `json:"consumer_name"`
	ConsumerGroup  string    `json:"consumer_group"`
	Sampled        bool      `json:"sampled" doc:"False when the SDK sampled the request out: a base record without headers or bodies."`
	TraceID        string    `json:"trace_id"`
}

type requestsOutput struct {
	Body struct {
		Requests   []requestRow `json:"requests" doc:"Newest first, then by trace id descending."`
		NextCursor string       `json:"next_cursor" doc:"Pass as cursor for the next (older) page; empty on the last page."`
	}
}

// statusRange is one inclusive status code range of a status filter.
type statusRange struct{ lo, hi int }

// parseStatusFilter parses a status filter: comma-separated codes, classes
// and ranges. It returns no ranges for all.
func parseStatusFilter(s string) ([]statusRange, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "all") {
		return nil, nil
	}
	terms := strings.Split(s, ",")
	if len(terms) > maxStatusTerms {
		return nil, fmt.Errorf("at most %d status terms", maxStatusTerms)
	}
	out := make([]statusRange, 0, len(terms))
	for _, t := range terms {
		t = strings.ToLower(strings.TrimSpace(t))
		if r, ok := statusClasses[t]; ok {
			out = append(out, statusRange{r[0], r[1]})
			continue
		}
		if t == "1xx" {
			out = append(out, statusRange{100, 199})
			continue
		}
		loS, hiS, isRange := strings.Cut(t, "-")
		lo, err := statusCode(loS)
		if err != nil {
			return nil, err
		}
		hi := lo
		if isRange {
			if hi, err = statusCode(hiS); err != nil {
				return nil, err
			}
			if hi < lo {
				return nil, fmt.Errorf("status range %q is reversed", t)
			}
		}
		out = append(out, statusRange{lo, hi})
	}
	return out, nil
}

func statusCode(s string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 100 || n > 599 {
		return 0, fmt.Errorf("%q is not a status code (100-599), class (1xx-5xx) or range (500-503)", s)
	}
	return n, nil
}

// requestCursor is the keyset position of the last row of a page.
type requestCursor struct {
	ms      int64 // timestamp, Unix milliseconds
	traceID string
}

func (c requestCursor) encode() string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(c.ms, 10) + ":" + c.traceID))
}

func decodeRequestCursor(s string) (requestCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return requestCursor{}, err
	}
	msS, trace, ok := strings.Cut(string(raw), ":")
	if !ok {
		return requestCursor{}, fmt.Errorf("malformed cursor")
	}
	ms, err := strconv.ParseInt(msS, 10, 64)
	if err != nil {
		return requestCursor{}, err
	}
	return requestCursor{ms: ms, traceID: trace}, nil
}

// likeContains is a case-insensitive LIKE pattern matching s anywhere, with
// the LIKE metacharacters of s escaped.
func likeContains(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}

// requestFilter builds the WHERE clause of the request log after the tenant,
// range and environment predicates.
func requestFilter(in *requestsInput, clauses []string, args []any) ([]string, []any, error) {
	eq := func(col, v string) {
		if v != "" {
			clauses = append(clauses, col+" = ?")
			args = append(args, v)
		}
	}
	eq("consumer_id", in.ConsumerID)
	eq("consumer_group", in.ConsumerGroup)
	eq("ip_address", in.IP)
	eq("method", strings.ToUpper(in.Method))
	eq("path", in.Path)
	eq("trace_id", in.TraceID)
	if in.URLContains != "" {
		clauses = append(clauses, "raw_path ILIKE ?")
		args = append(args, likeContains(in.URLContains))
	}
	if in.PayloadContains != "" {
		pat := likeContains(in.PayloadContains)
		clauses = append(clauses, "(request_payload ILIKE ? OR response_payload ILIKE ?)")
		args = append(args, pat, pat)
	}
	if in.RequestSizeMin > 0 {
		clauses = append(clauses, "request_size >= ?")
		args = append(args, in.RequestSizeMin)
	}
	if in.hasRequestSizeMax {
		clauses = append(clauses, "request_size <= ?")
		args = append(args, in.RequestSizeMax)
	}
	if in.ResponseSizeMin > 0 {
		clauses = append(clauses, "response_size >= ?")
		args = append(args, in.ResponseSizeMin)
	}
	if in.hasResponseSizeMax {
		clauses = append(clauses, "response_size <= ?")
		args = append(args, in.ResponseSizeMax)
	}
	if in.LatencyMin > 0 {
		clauses = append(clauses, "response_time_ms >= ?")
		args = append(args, in.LatencyMin)
	}
	if in.hasLatencyMax {
		clauses = append(clauses, "response_time_ms <= ?")
		args = append(args, in.LatencyMax)
	}
	switch in.Sampled {
	case "true":
		clauses = append(clauses, "sampled = 1")
	case "false":
		clauses = append(clauses, "sampled = 0")
	}
	ranges, err := parseStatusFilter(in.Status)
	if err != nil {
		return nil, nil, huma.Error422UnprocessableEntity("invalid status filter: " + err.Error())
	}
	if len(ranges) > 0 {
		or := make([]string, 0, len(ranges))
		for _, r := range ranges {
			or = append(or, "status_code BETWEEN ? AND ?")
			args = append(args, r.lo, r.hi)
		}
		clauses = append(clauses, "("+strings.Join(or, " OR ")+")")
	}
	if in.Cursor != "" {
		c, err := decodeRequestCursor(in.Cursor)
		if err != nil {
			return nil, nil, huma.Error422UnprocessableEntity("invalid cursor; pass next_cursor of the previous page")
		}
		clauses = append(clauses, "(timestamp, trace_id) < (fromUnixTimestamp64Milli(?, 'UTC'), ?)")
		args = append(args, c.ms, c.traceID)
	}
	return clauses, args, nil
}

func (s *Service) requests(ctx context.Context, in *requestsInput) (*requestsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	limit := min(max(in.Limit, 1), maxRequestsPage)
	where, args := tenantFilter(p.ProjectID, in.Env)
	clauses, args, err := requestFilter(in, []string{where, "timestamp >= ?", "timestamp < ?"}, append(args, w.from, w.to))
	if err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	// One row past the page tells whether there is a next one.
	rows, err := s.ch.Query(qctx, `
		SELECT timestamp, app_id, method, path, raw_path, status_code, response_time_ms, request_size, response_size,
		       environment, ip_address, consumer_id, consumer_name, consumer_group, sampled, trace_id
		FROM api_requests WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY timestamp DESC, trace_id DESC LIMIT ?`, append(args, limit+1)...)
	if err != nil {
		return nil, internalError("requests", err)
	}
	defer func() { _ = rows.Close() }()
	out := &requestsOutput{}
	out.Body.Requests = []requestRow{}
	more := false
	for rows.Next() {
		if len(out.Body.Requests) == limit {
			more = true
			break
		}
		var (
			r       requestRow
			app     uuid.UUID
			sampled uint8
		)
		if err := rows.Scan(&r.Timestamp, &app, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
			&r.RequestSize, &r.ResponseSize, &r.Environment, &r.IPAddress, &r.ConsumerID, &r.ConsumerName,
			&r.ConsumerGroup, &sampled, &r.TraceID); err != nil {
			return nil, internalError("requests", err)
		}
		r.AppID, r.Sampled = app.String(), sampled != 0
		out.Body.Requests = append(out.Body.Requests, r)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("requests", err)
	}
	if more {
		last := out.Body.Requests[len(out.Body.Requests)-1]
		out.Body.NextCursor = requestCursor{ms: last.Timestamp.UnixMilli(), traceID: last.TraceID}.encode()
	}
	return out, nil
}
