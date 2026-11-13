package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/authn"
)

// The quantile levels stored in the rollups (see the ClickHouse migration).
// Merges must use the same parameters; index 0 = p50, 3 = p95, 4 = p99.
const quantiles = "quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(latency)"

// ProjectInput documents the project query parameter; AuthMiddleware reads
// and authorizes it before the handler runs.
type ProjectInput struct {
	Project string `query:"project" maxLength:"63" example:"shop" doc:"Project slug. Required with a user session (the caller needs project.view); optional with a read key, where it must name the key's own project."`
}

// RangeInput is the time range and environment shared by the traffic
// operations. It is exported so Huma reads the fields of types embedding it.
type RangeInput struct {
	ProjectInput
	Range string `query:"range" enum:"1h,6h,24h,7d" default:"24h" doc:"Time range ending now."`
	Env   string `query:"env" maxLength:"64" doc:"Environment name; empty means all."`
}

// appRangeInput narrows the request totals and the timeseries to one app of
// the project (the Apps overview, #591).
type appRangeInput struct {
	RangeInput
	App string `query:"app" format:"uuid" doc:"App id; empty means every app of the project. An app of another project matches nothing."`
}

// withApp narrows a tenant filter to the app in, when one is given.
func withApp(where string, args []any, app string) (string, []any, error) {
	if app == "" {
		return where, args, nil
	}
	id, err := uuid.Parse(app)
	if err != nil {
		return "", nil, huma.Error422UnprocessableEntity("app must be a UUID")
	}
	return where + " AND app_id = ?", append(append([]any{}, args...), id), nil
}

// readAccess ends the description of every read-only dashboard operation.
const readAccess = " Callers authenticate with a project read key or a user session; with a session, project names the project " +
	"and the caller needs project.view. An ingest key answers 403."

// dashboardDescriptions documents the operations Register declares with op.
var dashboardDescriptions = map[string]string{
	"get-project": "The project the caller reads, its org, its active apps and the environments with traffic in the last 7 days.",
	"get-traffic-summary": "Totals of the range from the minute or hour rollups: requests, 4xx and 5xx errors (expected status codes " +
		"of each endpoint left out), latency percentiles, requests per minute and Apdex. Endpoints excluded from metrics are left out; " +
		"app narrows to one app.",
	"get-traffic-timeseries": "Requests, errors and p95 per bucket of the range (1 minute for 1h, 5 minutes for 6h, 15 minutes for 24h, " +
		"1 hour for 7d), oldest first and zero-filled. app narrows to one app.",
	"list-endpoints": "Per endpoint (method and route template) traffic, error split, latency percentiles and Apdex over the range, " +
		"most requests first. Routes an app declared with POST /v1/metadata but that had no traffic follow with zero counts.",
	"get-endpoint-requests": "The requests tab of an endpoint: totals by outcome, requests per minute, the outcome split per bucket " +
		"and the top consumers. An endpoint without traffic answers zeros, not 404.",
	"get-endpoint-latency": "The response-time tab of an endpoint: summary percentiles and Apdex, the p50/p75/p95 trend per bucket " +
		"and a fixed 14-bucket histogram over raw requests.",
	"get-endpoint-transfer": "The data-transferred tab of an endpoint: request and response byte totals and averages, bytes per bucket " +
		"and fixed 10-bucket size histograms for request and response bodies.",
	"get-endpoint-errors": "The errors tab of an endpoint: the 4xx/5xx split per bucket, error status codes by count, validation errors " +
		"grouped by field and server exceptions grouped by type and message. Expected status codes of the endpoint are left out.",
	"list-consumers": "The users of the API (consumers the SDK identified) with requests in the range, one page in sort order, each with " +
		"an outcome split, a sparkline and the latest consumer group the SDK reported; plus the total, request totals and unique consumers " +
		"per bucket split into new (first seen in the bucket) and returning. group keeps the requests the SDK tagged with that group; " +
		"search matches consumer ids and names.",
	"get-consumer": "One consumer: when it was first and last seen, the latest group the SDK reported for it, requests by outcome per " +
		"bucket, its top endpoints and a page of its latest requests and errors. A consumer the project never saw answers 404.",
	"list-requests": "The raw request log of the range, newest first, narrowed by any combination of filters (consumer, group, IP, " +
		"method, route, URL and payload substrings, sizes, status, latency, sampling, trace). Pages with next_cursor; from and to " +
		"narrow the window inside the range. An invalid status filter or cursor answers 422.",
	"get-request-timeline": "The same filters as list-requests, counted per bucket by status class, for the timeline above the log. " +
		"Every bucket of the window is listed, empty ones with zeros.",
	"get-request": "One request of the log by its id, with what was captured of it (headers, bodies, attributes, validation " +
		"errors) and the spans and logs of its trace in the project. An unknown id or another project's answers 404.",
	"list-errors": "Requests answered with 400 or above, grouped by endpoint and status code, most frequent first, with distinct " +
		"consumers and the last occurrence. Expected status codes and excluded endpoints are left out.",
	"get-trace": "The spans and correlated log records of one trace, restricted to the caller's project even when another project " +
		"shares the trace id. 404 when the project has neither spans nor logs for it.",
	"list-deploys": "Deploy markers (POST /v1/deploys) of the range, newest first, to draw on charts. env narrows to one environment.",
}

// Register mounts the dashboard operations on api. s may be nil when only the
// OpenAPI document is needed. guard authorizes the operations addressed by
// project slug in their path; nil refuses them with authz_unavailable (fail
// closed).
func Register(api huma.API, s *Service, guard *authz.Guard) {
	authn.AddSecurityScheme(api)
	AddSecurityScheme(api)
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Description: dashboardDescriptions[id] + readAccess, Tags: []string{"Dashboard"}, Security: security}
	}
	huma.Register(api, op("get-project", http.MethodGet, "/api/v1/project", "Project, apps and environments"), s.project)
	huma.Register(api, op("get-traffic-summary", http.MethodGet, "/api/v1/traffic/summary", "Request totals, error split and latency percentiles"), s.summary)
	huma.Register(api, op("get-traffic-timeseries", http.MethodGet, "/api/v1/traffic/timeseries", "Requests and errors per time bucket"), s.timeseries)
	huma.Register(api, op("list-endpoints", http.MethodGet, "/api/v1/traffic/endpoints", "Per-endpoint traffic, errors and latency"), s.endpoints)
	huma.Register(api, op("get-endpoint-requests", http.MethodGet, "/api/v1/endpoints/{method}/{path}/requests", "Endpoint requests: totals, status split over time and top consumers"), s.endpointRequests)
	huma.Register(api, op("get-endpoint-latency", http.MethodGet, "/api/v1/endpoints/{method}/{path}/latency", "Endpoint response time: percentiles, p50/p75/p95 trend and histogram"), s.endpointLatency)
	huma.Register(api, op("get-endpoint-transfer", http.MethodGet, "/api/v1/endpoints/{method}/{path}/transfer", "Endpoint data transferred: byte totals, in/out series and size histograms"), s.endpointTransfer)
	huma.Register(api, op("get-endpoint-errors", http.MethodGet, "/api/v1/endpoints/{method}/{path}/errors", "Endpoint errors: status breakdown, error-rate trend, validation errors and server exceptions"), s.endpointErrors)
	huma.Register(api, op("list-consumers", http.MethodGet, "/api/v1/consumers", "Consumers: traffic with sparklines, and unique consumers over time split new vs returning"), s.consumers)
	huma.Register(api, op("get-consumer", http.MethodGet, "/api/v1/consumers/{consumer_id}", "Consumer detail: first/last seen, requests and errors over time, recent requests and errors"), s.consumer)
	huma.Register(api, op("list-requests", http.MethodGet, "/api/v1/requests", "Request log: filtered requests, newest first, with cursor pagination"), s.requests)
	huma.Register(api, op("get-request-timeline", http.MethodGet, "/api/v1/requests/timeline", "Request timeline: the filtered request log counted per time bucket by status class"), s.requestTimeline)
	huma.Register(api, op("get-request", http.MethodGet, "/api/v1/requests/{id}", "Request detail: headers, bodies, validation errors, and the spans and logs of its trace"), s.requestDetail)
	huma.Register(api, op("list-errors", http.MethodGet, "/api/v1/errors", "Failed requests grouped by endpoint and status"), s.errors)
	huma.Register(api, op("get-trace", http.MethodGet, "/api/v1/traces/{trace_id}", "Spans and correlated logs of one trace"), s.trace)
	huma.Register(api, op("list-deploys", http.MethodGet, "/api/v1/deploys", "Deploy markers in a time range"), s.deploys)
	registerErrorStatus(api, s)
	registerTrafficLatency(api, s)
	registerDeployChanges(api, s)
	registerDeployDetail(api, s)
	registerIngestStatus(api, s, guard)
	registerAppStatus(api, s)
	registerEndpointSettings(api, s, guard)
	registerAppSettings(api, s, guard)
	registerAppIngestStats(api, s)
	registerSavedViews(api, s, guard)
	registerConsumerGroupTraffic(api, s)
	registerExports(api, s, guard)
	registerAlerts(api, s, guard)
	registerHealthChecks(api, s, guard)
	registerRetention(api, s, guard)
	registerProjectUsage(api, s, guard)
}

// ---------------------------------------------------------------- project

type named struct {
	ID   string `json:"id" doc:"Id (UUID)."`
	Slug string `json:"slug" doc:"URL-safe slug."`
	Name string `json:"name" doc:"Display name."`
}

type projectOutput struct {
	Body struct {
		Org          named    `json:"org" doc:"The organization that owns the project."`
		Project      named    `json:"project" doc:"The project."`
		Apps         []named  `json:"apps" doc:"The project's active apps."`
		Environments []string `json:"environments" doc:"Environments with traffic in the last 7 days."`
	}
}

func (s *Service) project(ctx context.Context, _ *ProjectInput) (*projectOutput, error) {
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
		Range             string    `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From              time.Time `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To                time.Time `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		Requests          uint64    `json:"requests" doc:"Requests in the range."`
		ClientErrors      uint64    `json:"client_errors" doc:"4xx responses, leaving out the expected status codes of each endpoint."`
		ServerErrors      uint64    `json:"server_errors" doc:"5xx responses, leaving out the expected status codes of each endpoint."`
		ErrorRate         float64   `json:"error_rate" doc:"(client_errors + server_errors) / requests"`
		P50Ms             float64   `json:"p50_ms" doc:"Median response time, in milliseconds (t-digest estimate)."`
		P95Ms             float64   `json:"p95_ms" doc:"95th percentile response time, in milliseconds (t-digest estimate)."`
		P99Ms             float64   `json:"p99_ms" doc:"99th percentile response time, in milliseconds (t-digest estimate)."`
		RequestsPerMinute float64   `json:"requests_per_minute" doc:"requests / minutes of the range."`
		Apdex             *float64  `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1, (satisfied + tolerating / 2) / requests with satisfied <= T < tolerating <= 4T, where T is the endpoint's latency threshold, else its app's, else 500 ms; null without requests."`
	}
}

func (s *Service) summary(ctx context.Context, in *appRangeInput) (*summaryOutput, error) {
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
	tenant, targs := tenantFilter(p.ProjectID, in.Env)
	tenant, targs, err = withApp(tenant, targs, in.App)
	if err != nil {
		return nil, err
	}
	where, args := rules.withoutExcluded(tenant, targs)
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
	expected, err := s.expectedErrors(qctx, rules, tenant, targs, w.from, w.to, "''")
	if err != nil {
		return nil, err
	}
	expected[""].subtract(&clientErrors, &serverErrors)
	thresholds, err := s.apdexThresholds(ctx, p.ProjectID)
	if err != nil {
		return nil, err
	}
	apdex, err := s.apdex(qctx, thresholds, where+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, args...), w.from, w.to), "''")
	if err != nil {
		return nil, err
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
	b.Apdex = apdex[""].score()
	return out, nil
}

// ---------------------------------------------------------------- timeseries

type point struct {
	TS           time.Time `json:"ts" doc:"Start of the bucket."`
	Requests     uint64    `json:"requests" doc:"Requests in the bucket."`
	ClientErrors uint64    `json:"client_errors" doc:"4xx responses in the bucket, expected status codes left out."`
	ServerErrors uint64    `json:"server_errors" doc:"5xx responses in the bucket, expected status codes left out."`
	P95Ms        float64   `json:"p95_ms" doc:"95th percentile response time of the bucket, in milliseconds; 0 without requests."`
}

type timeseriesOutput struct {
	Body struct {
		Range         string  `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		BucketSeconds int     `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Points        []point `json:"points" doc:"One point per bucket of the range, oldest first, zero-filled."`
	}
}

func (s *Service) timeseries(ctx context.Context, in *appRangeInput) (*timeseriesOutput, error) {
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
	tenant, targs := tenantFilter(p.ProjectID, in.Env)
	tenant, targs, err = withApp(tenant, targs, in.App)
	if err != nil {
		return nil, err
	}
	where, args := rules.withoutExcluded(tenant, targs)
	seconds := int(w.bucket.Seconds())
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	expected, err := s.expectedErrors(qctx, rules, tenant, targs, w.from, w.to,
		fmt.Sprintf("toString(toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL %d SECOND)))", seconds))
	if err != nil {
		return nil, err
	}
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
		expected[strconv.FormatInt(pt.TS.UTC().Unix(), 10)].subtract(&pt.ClientErrors, &pt.ServerErrors)
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
	RangeInput
	Limit int `query:"limit" minimum:"1" maximum:"500" default:"100" doc:"Most endpoints to list, by requests."`
}

type endpoint struct {
	Method       string   `json:"method" doc:"HTTP method of the endpoint, upper case."`
	Path         string   `json:"path" doc:"Route template of the endpoint, e.g. /orders/{id}."`
	Requests     uint64   `json:"requests" doc:"Requests in the range."`
	ClientErrors uint64   `json:"client_errors" doc:"4xx responses, expected status codes of the endpoint left out."`
	ServerErrors uint64   `json:"server_errors" doc:"5xx responses, expected status codes of the endpoint left out."`
	ErrorRate    float64  `json:"error_rate" doc:"(client_errors + server_errors) / requests; 0 without requests."`
	P50Ms        float64  `json:"p50_ms" doc:"Median response time, in milliseconds."`
	P95Ms        float64  `json:"p95_ms" doc:"95th percentile response time, in milliseconds."`
	Apdex        *float64 `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1 against the endpoint's latency threshold (else its app's, else 500 ms); null without requests."`
	// DiscoveredOnly marks a route an app declared in its metadata that had
	// no traffic in the range; its counts are zero.
	DiscoveredOnly bool `json:"discovered_only" doc:"True for a route an app declared (POST /v1/metadata) without traffic in the range; its counts are zero and it is listed after the endpoints with traffic."`
}

type endpointsOutput struct {
	Body struct {
		Endpoints []endpoint `json:"endpoints" doc:"Endpoints by requests, most first, then routes discovered without traffic; endpoints excluded from metrics are left out."`
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
	rules, err := s.endpointRules(ctx, p.ProjectID)
	if err != nil {
		return nil, err
	}
	tenant, targs := tenantFilter(p.ProjectID, in.Env)
	where, args := rules.withoutExcluded(tenant, targs)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	expected, err := s.expectedErrors(qctx, rules, tenant, targs, w.from, w.to, "concat(method, ' ', path)")
	if err != nil {
		return nil, err
	}
	thresholds, err := s.apdexThresholds(ctx, p.ProjectID)
	if err != nil {
		return nil, err
	}
	apdex, err := s.apdex(qctx, thresholds, where+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, args...), w.from, w.to), "concat(method, ' ', path)")
	if err != nil {
		return nil, err
	}
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
		expected[e.Method+" "+e.Path].subtract(&e.ClientErrors, &e.ServerErrors)
		if e.Requests > 0 {
			e.ErrorRate = float64(e.ClientErrors+e.ServerErrors) / float64(e.Requests)
		}
		e.P50Ms, e.P95Ms = quantile(q, 0), quantile(q, 3)
		e.Apdex = apdex[e.Method+" "+e.Path].score()
		out.Body.Endpoints = append(out.Body.Endpoints, e)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("endpoints", err)
	}
	if len(out.Body.Endpoints) < in.Limit {
		routes, err := s.discoveredRoutes(ctx, p.ProjectID, in.Env)
		if err != nil {
			return nil, err
		}
		out.Body.Endpoints = withDiscovered(out.Body.Endpoints, routes, rules, in.Limit)
	}
	return out, nil
}

// statusClasses are the status code ranges of the status filters.
var statusClasses = map[string][2]int{"2xx": {200, 299}, "3xx": {300, 399}, "4xx": {400, 499}, "5xx": {500, 599}}

// ---------------------------------------------------------------- errors

type errorGroup struct {
	Method     string    `json:"method" doc:"HTTP method of the endpoint, upper case."`
	Path       string    `json:"path" doc:"Route template of the endpoint, e.g. /orders/{id}."`
	StatusCode uint16    `json:"status_code" doc:"Error status code (400 and above)."`
	Count      uint64    `json:"count" doc:"Occurrences in the range."`
	Consumers  uint64    `json:"consumers" doc:"Distinct consumers that got the error."`
	LastSeen   time.Time `json:"last_seen" doc:"Latest occurrence in the range."`
}

type errorsOutput struct {
	Body struct {
		Errors []errorGroup `json:"errors" doc:"Error groups by (endpoint, status code), most frequent first (at most 200)."`
	}
}

func (s *Service) errors(ctx context.Context, in *RangeInput) (*errorsOutput, error) {
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
	where, args := rules.withoutExcluded(tenantFilter(p.ProjectID, in.Env))
	where += " AND timestamp >= ? AND timestamp < ? AND status_code >= 400"
	args = append(args, w.from, w.to)
	if pred, pargs := rules.expectedPredicate(); pred != "" {
		where += " AND NOT " + pred
		args = append(args, pargs...)
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT method, path, status_code, count() AS c, uniqIf(consumer_id, consumer_id != ''), max(timestamp)
		FROM api_requests WHERE `+where+`
		GROUP BY method, path, status_code ORDER BY c DESC LIMIT 200`, args...)
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
	ProjectInput
	TraceID string `path:"trace_id" pattern:"^[0-9a-f]{32}$" example:"4bf92f3577b34da6a3ce929d0e0e4736" doc:"W3C trace id (32 lowercase hex characters)."`
}

type spanOut struct {
	SpanID       string            `json:"span_id" doc:"Span id (16 lowercase hex characters)."`
	ParentSpanID string            `json:"parent_span_id" doc:"Parent span id; empty for a root span."`
	Name         string            `json:"name" doc:"Span name, e.g. GET /orders/{id} or SELECT orders."`
	Kind         string            `json:"kind" doc:"OpenTelemetry span kind: server, client, internal, producer or consumer."`
	ServiceName  string            `json:"service_name" doc:"Service that recorded the span."`
	Start        time.Time         `json:"start" doc:"Start time of the span."`
	DurationMs   float64           `json:"duration_ms" doc:"Duration, in milliseconds."`
	Status       string            `json:"status" doc:"Span status: ok, error or unset."`
	StatusCode   uint16            `json:"status_code" doc:"HTTP status code of an HTTP span; 0 otherwise."`
	Attributes   map[string]string `json:"attributes" doc:"Span attributes, as strings."`
}

type traceLog struct {
	Timestamp time.Time `json:"timestamp" doc:"When the log record was emitted."`
	Level     string    `json:"level" doc:"Log level, e.g. INFO, WARNING, ERROR."`
	Message   string    `json:"message" doc:"Log message."`
	SpanID    string    `json:"span_id" doc:"Span the record was emitted in; empty when none."`
}

type traceOutput struct {
	Body struct {
		TraceID string     `json:"trace_id" doc:"The trace id asked for."`
		Spans   []spanOut  `json:"spans" doc:"Spans of the trace in the project, oldest first (at most 2000)."`
		Logs    []traceLog `json:"logs" doc:"Log records correlated with the trace, oldest first (at most 500)."`
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
	out.Body.Spans, out.Body.Logs, err = s.traceSpansAndLogs(qctx, p.ProjectID, in.TraceID)
	if err != nil {
		return nil, err
	}
	if len(out.Body.Spans) == 0 && len(out.Body.Logs) == 0 {
		return nil, huma.Error404NotFound("no spans or logs for this trace in the project")
	}
	return out, nil
}

// traceSpansAndLogs reads the spans (at most 2000) and correlated logs (at
// most 500) of one trace of a project, oldest first.
func (s *Service) traceSpansAndLogs(ctx context.Context, project uuid.UUID, traceID string) ([]spanOut, []traceLog, error) {
	spans, logs := []spanOut{}, []traceLog{}
	rows, err := s.ch.Query(ctx, `
		SELECT span_id, parent_span_id, name, kind, service_name, timestamp, duration_ms, status, status_code, attributes
		FROM api_spans WHERE project_id = ? AND trace_id = ? ORDER BY timestamp, span_id LIMIT 2000`, project, traceID)
	if err != nil {
		return nil, nil, internalError("trace spans", err)
	}
	for rows.Next() {
		var sp spanOut
		if err := rows.Scan(&sp.SpanID, &sp.ParentSpanID, &sp.Name, &sp.Kind, &sp.ServiceName, &sp.Start, &sp.DurationMs,
			&sp.Status, &sp.StatusCode, &sp.Attributes); err != nil {
			_ = rows.Close()
			return nil, nil, internalError("trace spans", err)
		}
		spans = append(spans, sp)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, internalError("trace spans", err)
	}

	lrows, err := s.ch.Query(ctx, `
		SELECT timestamp, level, message, span_id
		FROM api_logs WHERE project_id = ? AND trace_id = ? ORDER BY timestamp LIMIT 500`, project, traceID)
	if err != nil {
		return nil, nil, internalError("trace logs", err)
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		var l traceLog
		if err := lrows.Scan(&l.Timestamp, &l.Level, &l.Message, &l.SpanID); err != nil {
			return nil, nil, internalError("trace logs", err)
		}
		logs = append(logs, l)
	}
	if err := lrows.Err(); err != nil {
		return nil, nil, internalError("trace logs", err)
	}
	return spans, logs, nil
}

// ---------------------------------------------------------------- deploys

type deployOut struct {
	DeployedAt  time.Time `json:"deployed_at" doc:"When the deploy happened, as reported."`
	Release     string    `json:"release" doc:"Release name or version that was deployed."`
	Commit      string    `json:"commit" doc:"Commit that was deployed; empty when not reported."`
	Environment string    `json:"environment" doc:"Environment deployed to."`
	URL         string    `json:"url" doc:"Link to the release or CI run; empty when not reported."`
}

type deploysOutput struct {
	Body struct {
		Deploys []deployOut `json:"deploys" doc:"Deploys of the range, newest first (at most 100)."`
	}
}

func (s *Service) deploys(ctx context.Context, in *RangeInput) (*deploysOutput, error) {
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
