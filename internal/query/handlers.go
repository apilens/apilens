package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// The quantile levels stored in the rollups (see the ClickHouse migration).
// Merges must use the same parameters; index 0 = p50, 3 = p95, 4 = p99.
const quantiles = "quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(latency)"

type rangeInput struct {
	Range string `query:"range" enum:"1h,6h,24h,7d" default:"24h" doc:"Time range ending now."`
	Env   string `query:"env" maxLength:"64" doc:"Environment name; empty means all."`
}

// Register mounts the dashboard operations on api. s may be nil when only the
// OpenAPI document is needed.
func Register(api huma.API, s *Service) {
	AddSecurityScheme(api)
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{"Dashboard"}, Security: security}
	}
	huma.Register(api, op("get-project", http.MethodGet, "/api/v1/project", "Project, apps and environments of the read key"), s.project)
	huma.Register(api, op("get-traffic-summary", http.MethodGet, "/api/v1/traffic/summary", "Request totals, error split and latency percentiles"), s.summary)
	huma.Register(api, op("get-traffic-timeseries", http.MethodGet, "/api/v1/traffic/timeseries", "Requests and errors per time bucket"), s.timeseries)
	huma.Register(api, op("list-endpoints", http.MethodGet, "/api/v1/traffic/endpoints", "Per-endpoint traffic, errors and latency"), s.endpoints)
	huma.Register(api, op("list-requests", http.MethodGet, "/api/v1/requests", "Most recent requests"), s.requests)
	huma.Register(api, op("list-errors", http.MethodGet, "/api/v1/errors", "Failed requests grouped by endpoint and status"), s.errors)
	huma.Register(api, op("get-trace", http.MethodGet, "/api/v1/traces/{trace_id}", "Spans and correlated logs of one trace"), s.trace)
	huma.Register(api, op("list-deploys", http.MethodGet, "/api/v1/deploys", "Deploy markers in a time range"), s.deploys)
}

// ---------------------------------------------------------------- project

type named struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type projectOutput struct {
	Body struct {
		Org          named    `json:"org"`
		Project      named    `json:"project"`
		Apps         []named  `json:"apps"`
		Environments []string `json:"environments" doc:"Environments with traffic in the last 7 days."`
	}
}

func (s *Service) project(ctx context.Context, _ *struct{}) (*projectOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	row, err := s.catalog.GetProjectWithOrg(ctx, p.ProjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("project not found")
	}
	if err != nil {
		return nil, internalError("project lookup", err)
	}
	apps, err := s.catalog.ListProjectApps(ctx, p.ProjectID)
	if err != nil {
		return nil, internalError("app lookup", err)
	}
	out := &projectOutput{}
	out.Body.Org = named{ID: row.OrgID.String(), Slug: row.OrgSlug, Name: row.OrgName}
	out.Body.Project = named{ID: row.ID.String(), Slug: row.Slug, Name: row.Name}
	out.Body.Apps = make([]named, 0, len(apps))
	for _, a := range apps {
		out.Body.Apps = append(out.Body.Apps, named{ID: a.ID.String(), Slug: a.Slug, Name: a.Name})
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `SELECT DISTINCT environment FROM api_requests_1h
		WHERE project_id = ? AND bucket >= ? ORDER BY environment`, p.ProjectID, s.now().UTC().Add(-7*24*time.Hour))
	if err != nil {
		return nil, internalError("environments", err)
	}
	defer func() { _ = rows.Close() }()
	out.Body.Environments = []string{}
	for rows.Next() {
		var env string
		if err := rows.Scan(&env); err != nil {
			return nil, internalError("environments", err)
		}
		out.Body.Environments = append(out.Body.Environments, env)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- summary

type summaryOutput struct {
	Body struct {
		Range             string    `json:"range"`
		From              time.Time `json:"from"`
		To                time.Time `json:"to"`
		Requests          uint64    `json:"requests"`
		ClientErrors      uint64    `json:"client_errors"`
		ServerErrors      uint64    `json:"server_errors"`
		ErrorRate         float64   `json:"error_rate" doc:"(client_errors + server_errors) / requests"`
		P50Ms             float64   `json:"p50_ms"`
		P95Ms             float64   `json:"p95_ms"`
		P99Ms             float64   `json:"p99_ms"`
		RequestsPerMinute float64   `json:"requests_per_minute"`
	}
}

func (s *Service) summary(ctx context.Context, in *rangeInput) (*summaryOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	var (
		requests, clientErrors, serverErrors uint64
		q                                    []float32
	)
	err = s.ch.QueryRow(qctx, fmt.Sprintf(`
		SELECT sum(requests), sum(client_errors), sum(server_errors), %s
		FROM %s WHERE %s AND bucket >= ? AND bucket < ?`, quantiles, w.table, where),
		append(args, w.from, w.to)...).Scan(&requests, &clientErrors, &serverErrors, &q)
	if err != nil {
		return nil, internalError("summary", err)
	}
	out := &summaryOutput{}
	b := &out.Body
	b.Range, b.From, b.To = w.name, w.from, w.to
	b.Requests, b.ClientErrors, b.ServerErrors = requests, clientErrors, serverErrors
	if requests > 0 {
		b.ErrorRate = float64(clientErrors+serverErrors) / float64(requests)
		b.P50Ms, b.P95Ms, b.P99Ms = quantile(q, 0), quantile(q, 3), quantile(q, 4)
	}
	b.RequestsPerMinute = float64(requests) / w.to.Sub(w.from).Minutes()
	return out, nil
}

// ---------------------------------------------------------------- timeseries

type point struct {
	TS           time.Time `json:"ts"`
	Requests     uint64    `json:"requests"`
	ClientErrors uint64    `json:"client_errors"`
	ServerErrors uint64    `json:"server_errors"`
	P95Ms        float64   `json:"p95_ms"`
}

type timeseriesOutput struct {
	Body struct {
		Range         string  `json:"range"`
		BucketSeconds int     `json:"bucket_seconds"`
		Points        []point `json:"points"`
	}
}

func (s *Service) timeseries(ctx context.Context, in *rangeInput) (*timeseriesOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	seconds := int(w.bucket.Seconds())
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	// table and bucket width come from the fixed ranges map, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(bucket, INTERVAL %d SECOND) AS ts,
		       sum(requests), sum(client_errors), sum(server_errors), %s
		FROM %s WHERE %s AND bucket >= ? AND bucket < ?
		GROUP BY ts ORDER BY ts`, seconds, quantiles, w.table, where), append(args, w.from, w.to)...)
	if err != nil {
		return nil, internalError("timeseries", err)
	}
	defer func() { _ = rows.Close() }()
	got := map[int64]point{}
	for rows.Next() {
		var (
			pt point
			q  []float32
		)
		if err := rows.Scan(&pt.TS, &pt.Requests, &pt.ClientErrors, &pt.ServerErrors, &q); err != nil {
			return nil, internalError("timeseries", err)
		}
		pt.P95Ms = quantile(q, 3)
		got[pt.TS.UTC().Unix()] = pt
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("timeseries", err)
	}
	out := &timeseriesOutput{}
	out.Body.Range, out.Body.BucketSeconds = w.name, seconds
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		pt, ok := got[t.Unix()]
		if !ok {
			pt = point{}
		}
		pt.TS = t
		out.Body.Points = append(out.Body.Points, pt)
	}
	return out, nil
}

// ---------------------------------------------------------------- endpoints

type endpointsInput struct {
	rangeInput
	Limit int `query:"limit" minimum:"1" maximum:"500" default:"100"`
}

type endpoint struct {
	Method       string  `json:"method"`
	Path         string  `json:"path"`
	Requests     uint64  `json:"requests"`
	ClientErrors uint64  `json:"client_errors"`
	ServerErrors uint64  `json:"server_errors"`
	ErrorRate    float64 `json:"error_rate"`
	P50Ms        float64 `json:"p50_ms"`
	P95Ms        float64 `json:"p95_ms"`
}

type endpointsOutput struct {
	Body struct {
		Endpoints []endpoint `json:"endpoints"`
	}
}

func (s *Service) endpoints(ctx context.Context, in *endpointsInput) (*endpointsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT method, path, sum(requests) AS total, sum(client_errors), sum(server_errors), %s
		FROM %s WHERE %s AND bucket >= ? AND bucket < ?
		GROUP BY method, path ORDER BY total DESC, path LIMIT ?`, quantiles, w.table, where),
		append(args, w.from, w.to, in.Limit)...)
	if err != nil {
		return nil, internalError("endpoints", err)
	}
	defer func() { _ = rows.Close() }()
	out := &endpointsOutput{}
	out.Body.Endpoints = []endpoint{}
	for rows.Next() {
		var (
			e endpoint
			q []float32
		)
		if err := rows.Scan(&e.Method, &e.Path, &e.Requests, &e.ClientErrors, &e.ServerErrors, &q); err != nil {
			return nil, internalError("endpoints", err)
		}
		if e.Requests > 0 {
			e.ErrorRate = float64(e.ClientErrors+e.ServerErrors) / float64(e.Requests)
		}
		e.P50Ms, e.P95Ms = quantile(q, 0), quantile(q, 3)
		out.Body.Endpoints = append(out.Body.Endpoints, e)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- requests

type requestsInput struct {
	rangeInput
	Status string `query:"status" enum:"all,2xx,3xx,4xx,5xx" default:"all"`
	Path   string `query:"path" maxLength:"1024" doc:"Route template, e.g. /orders/{id}."`
	Limit  int    `query:"limit" minimum:"1" maximum:"500" default:"100"`
}

type requestRow struct {
	Timestamp      time.Time `json:"timestamp"`
	Method         string    `json:"method"`
	Path           string    `json:"path"`
	RawPath        string    `json:"raw_path"`
	StatusCode     uint16    `json:"status_code"`
	ResponseTimeMs float64   `json:"response_time_ms"`
	Environment    string    `json:"environment"`
	ConsumerID     string    `json:"consumer_id"`
	ConsumerName   string    `json:"consumer_name"`
	TraceID        string    `json:"trace_id"`
}

type requestsOutput struct {
	Body struct {
		Requests []requestRow `json:"requests"`
	}
}

var statusClasses = map[string][2]int{"2xx": {200, 299}, "3xx": {300, 399}, "4xx": {400, 499}, "5xx": {500, 599}}

func (s *Service) requests(ctx context.Context, in *requestsInput) (*requestsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	clauses := []string{where, "timestamp >= ?", "timestamp < ?"}
	args = append(args, w.from, w.to)
	if r, ok := statusClasses[in.Status]; ok {
		clauses = append(clauses, "status_code BETWEEN ? AND ?")
		args = append(args, r[0], r[1])
	}
	if in.Path != "" {
		clauses = append(clauses, "path = ?")
		args = append(args, in.Path)
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT timestamp, method, path, raw_path, status_code, response_time_ms, environment, consumer_id, consumer_name, trace_id
		FROM api_requests WHERE `+strings.Join(clauses, " AND ")+`
		ORDER BY timestamp DESC LIMIT ?`, append(args, in.Limit)...)
	if err != nil {
		return nil, internalError("requests", err)
	}
	defer func() { _ = rows.Close() }()
	out := &requestsOutput{}
	out.Body.Requests = []requestRow{}
	for rows.Next() {
		var r requestRow
		if err := rows.Scan(&r.Timestamp, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
			&r.Environment, &r.ConsumerID, &r.ConsumerName, &r.TraceID); err != nil {
			return nil, internalError("requests", err)
		}
		out.Body.Requests = append(out.Body.Requests, r)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- errors

type errorGroup struct {
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	StatusCode uint16    `json:"status_code"`
	Count      uint64    `json:"count"`
	Consumers  uint64    `json:"consumers"`
	LastSeen   time.Time `json:"last_seen"`
}

type errorsOutput struct {
	Body struct {
		Errors []errorGroup `json:"errors"`
	}
}

func (s *Service) errors(ctx context.Context, in *rangeInput) (*errorsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT method, path, status_code, count() AS c, uniqIf(consumer_id, consumer_id != ''), max(timestamp)
		FROM api_requests WHERE `+where+` AND timestamp >= ? AND timestamp < ? AND status_code >= 400
		GROUP BY method, path, status_code ORDER BY c DESC LIMIT 200`, append(args, w.from, w.to)...)
	if err != nil {
		return nil, internalError("errors", err)
	}
	defer func() { _ = rows.Close() }()
	out := &errorsOutput{}
	out.Body.Errors = []errorGroup{}
	for rows.Next() {
		var g errorGroup
		if err := rows.Scan(&g.Method, &g.Path, &g.StatusCode, &g.Count, &g.Consumers, &g.LastSeen); err != nil {
			return nil, internalError("errors", err)
		}
		out.Body.Errors = append(out.Body.Errors, g)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- trace

type traceInput struct {
	TraceID string `path:"trace_id" pattern:"^[0-9a-f]{32}$" doc:"W3C trace id (32 lowercase hex characters)."`
}

type spanOut struct {
	SpanID       string            `json:"span_id"`
	ParentSpanID string            `json:"parent_span_id"`
	Name         string            `json:"name"`
	Kind         string            `json:"kind"`
	ServiceName  string            `json:"service_name"`
	Start        time.Time         `json:"start"`
	DurationMs   float64           `json:"duration_ms"`
	Status       string            `json:"status"`
	StatusCode   uint16            `json:"status_code"`
	Attributes   map[string]string `json:"attributes"`
}

type traceLog struct {
	Timestamp time.Time `json:"timestamp"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	SpanID    string    `json:"span_id"`
}

type traceOutput struct {
	Body struct {
		TraceID string     `json:"trace_id"`
		Spans   []spanOut  `json:"spans"`
		Logs    []traceLog `json:"logs"`
	}
}

func (s *Service) trace(ctx context.Context, in *traceInput) (*traceOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &traceOutput{}
	out.Body.TraceID = in.TraceID
	out.Body.Spans, out.Body.Logs = []spanOut{}, []traceLog{}

	rows, err := s.ch.Query(qctx, `
		SELECT span_id, parent_span_id, name, kind, service_name, timestamp, duration_ms, status, status_code, attributes
		FROM api_spans WHERE project_id = ? AND trace_id = ? ORDER BY timestamp, span_id LIMIT 2000`, p.ProjectID, in.TraceID)
	if err != nil {
		return nil, internalError("trace spans", err)
	}
	for rows.Next() {
		var sp spanOut
		if err := rows.Scan(&sp.SpanID, &sp.ParentSpanID, &sp.Name, &sp.Kind, &sp.ServiceName, &sp.Start, &sp.DurationMs,
			&sp.Status, &sp.StatusCode, &sp.Attributes); err != nil {
			_ = rows.Close()
			return nil, internalError("trace spans", err)
		}
		out.Body.Spans = append(out.Body.Spans, sp)
	}
	_ = rows.Close()

	logs, err := s.ch.Query(qctx, `
		SELECT timestamp, level, message, span_id
		FROM api_logs WHERE project_id = ? AND trace_id = ? ORDER BY timestamp LIMIT 500`, p.ProjectID, in.TraceID)
	if err != nil {
		return nil, internalError("trace logs", err)
	}
	defer func() { _ = logs.Close() }()
	for logs.Next() {
		var l traceLog
		if err := logs.Scan(&l.Timestamp, &l.Level, &l.Message, &l.SpanID); err != nil {
			return nil, internalError("trace logs", err)
		}
		out.Body.Logs = append(out.Body.Logs, l)
	}
	if len(out.Body.Spans) == 0 && len(out.Body.Logs) == 0 {
		return nil, huma.Error404NotFound("no spans or logs for this trace in the project")
	}
	return out, logs.Err()
}

// ---------------------------------------------------------------- deploys

type deployOut struct {
	DeployedAt  time.Time `json:"deployed_at"`
	Release     string    `json:"release"`
	Commit      string    `json:"commit"`
	Environment string    `json:"environment"`
	URL         string    `json:"url"`
}

type deploysOutput struct {
	Body struct {
		Deploys []deployOut `json:"deploys"`
	}
}

func (s *Service) deploys(ctx context.Context, in *rangeInput) (*deploysOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT deployed_at, release, commit, environment, url
		FROM api_deploys WHERE `+where+` AND deployed_at >= ? AND deployed_at < ?
		ORDER BY deployed_at DESC LIMIT 100`, append(args, w.from, w.to)...)
	if err != nil {
		return nil, internalError("deploys", err)
	}
	defer func() { _ = rows.Close() }()
	out := &deploysOutput{}
	out.Body.Deploys = []deployOut{}
	for rows.Next() {
		var d deployOut
		if err := rows.Scan(&d.DeployedAt, &d.Release, &d.Commit, &d.Environment, &d.URL); err != nil {
			return nil, internalError("deploys", err)
		}
		out.Body.Deploys = append(out.Body.Deploys, d)
	}
	return out, rows.Err()
}
