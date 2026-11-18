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
	"get-project": "The project the caller reads, its org, its active apps and the environments for pickers: the project's visible environments in their set order, " +
		"then environments with traffic in the last 7 days that are not registered yet (by name), and the hidden environments apart.",
	"get-traffic-summary": "Totals of the range from the minute or hour rollups: requests, 4xx and 5xx errors (expected status codes " +
		"of each endpoint left out), latency percentiles, requests per minute and Apdex. Endpoints excluded from metrics are left out; " +
		"app narrows to one app.",
	"get-traffic-timeseries": "Requests, errors and p95 per bucket of the range (1 minute for 1h, 5 minutes for 6h, 15 minutes for 24h, " +
		"1 hour for 7d), oldest first and zero-filled. app narrows to one app.",
	"list-endpoints": "Per endpoint (app, method and route template) traffic, error split, latency percentiles and Apdex over the range, " +
		"most requests first: a route served by several apps is one row per app. Routes an app declared with POST /v1/metadata but " +
		"that had no traffic follow with zero counts. app narrows to one app.",
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
		"narrow the window inside the range. An invalid status filter, filter condition or cursor answers 422. filter: " + filterDoc,
	"get-request-timeline": "The same filters as list-requests, counted per bucket by status class, for the timeline above the log. " +
		"Every bucket of the window is listed, empty ones with zeros. filter: " + filterDoc,
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
	registerSlowestRequests(api, s)
	registerRequestFacets(api, s)
	registerDeployChanges(api, s)
	registerDeployDetail(api, s)
	registerIngestStatus(api, s, guard)
	registerAppStatus(api, s)
	registerEndpointSettings(api, s, guard)
	registerAppSettings(api, s, guard)
	registerAppIngestStats(api, s)
	registerSavedViews(api, s, guard)
	registerConsumerGroupTraffic(api, s)
	registerAnonymousCallers(api, s)
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
		Environments []string `json:"environments" doc:"Visible environments in the project's order, then unregistered environments with traffic in the last 7 days, by name."`
		Hidden       []string `json:"hidden" doc:"Hidden environments in the project's order; pickers leave them out by default."`
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

	registered, err := s.catalog.ListPickerEnvironments(ctx, p.ProjectID)
	if err != nil {
		return nil, internalError("environment lookup", err)
	}
	known := make(map[string]bool, len(registered))
	out.Body.Environments, out.Body.Hidden = []string{}, []string{}
	for _, e := range registered {
		known[e.Name] = true
		if e.Hidden {
			out.Body.Hidden = append(out.Body.Hidden, e.Name)
		} else {
			out.Body.Environments = append(out.Body.Environments, e.Name)
		}
	}

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `SELECT DISTINCT environment FROM api_requests_1h
		WHERE project_id = ? AND bucket >= ? ORDER BY environment`, p.ProjectID, s.now().UTC().Add(-7*24*time.Hour))
	if err != nil {
		return nil, internalError("environments", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var env string
		if err := rows.Scan(&env); err != nil {
			return nil, internalError("environments", err)
		}
		if !known[env] {
			out.Body.Environments = append(out.Body.Environments, env)
		}
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- summary

type summaryOutput struct {
	Body struct {
		Range             string         `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From              time.Time      `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To                time.Time      `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		Requests          uint64         `json:"requests" doc:"Requests in the range."`
		ClientErrors      uint64         `json:"client_errors" doc:"4xx responses, leaving out the expected status codes of each endpoint."`
		ServerErrors      uint64         `json:"server_errors" doc:"5xx responses, leaving out the expected status codes of each endpoint."`
		ErrorRate         float64        `json:"error_rate" doc:"(client_errors + server_errors) / requests"`
		P50Ms             float64        `json:"p50_ms" doc:"Median response time, in milliseconds (t-digest estimate)."`
		P95Ms             float64        `json:"p95_ms" doc:"95th percentile response time, in milliseconds (t-digest estimate)."`
		P99Ms             float64        `json:"p99_ms" doc:"99th percentile response time, in milliseconds (t-digest estimate)."`
		RequestsPerMinute float64        `json:"requests_per_minute" doc:"requests / minutes of the active span: the range, or the time since the first bucket with data when that is shorter."`
		CurrentPerMinute  float64        `json:"current_per_minute" doc:"Requests in the last full minute."`
		Apdex             *float64       `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1, (satisfied + tolerating / 2) / requests with satisfied <= T < tolerating <= 4T, where T is the endpoint's latency threshold, else its app's, else 500 ms; requests answered with a 5xx the endpoint does not expect are frustrated whatever their response time; null without requests."`
		Previous          *summaryTotals `json:"previous,omitempty" doc:"The same totals over the window of the same length just before the range, the baseline of the comparison on the tiles; left out when that window has no requests."`
	}
}

// summaryTotals are the totals of the summary over one window: the range
// itself, or the window before it for the comparison (#1000).
type summaryTotals struct {
	From         time.Time `json:"from" doc:"Start of the window (inclusive, bucket-aligned)."`
	To           time.Time `json:"to" doc:"End of the window (exclusive, bucket-aligned)."`
	Requests     uint64    `json:"requests" doc:"Requests in the window."`
	ClientErrors uint64    `json:"client_errors" doc:"4xx responses, leaving out the expected status codes of each endpoint."`
	ServerErrors uint64    `json:"server_errors" doc:"5xx responses, leaving out the expected status codes of each endpoint."`
	ErrorRate    float64   `json:"error_rate" doc:"(client_errors + server_errors) / requests"`
	P50Ms        float64   `json:"p50_ms" doc:"Median response time, in milliseconds (t-digest estimate)."`
	P95Ms        float64   `json:"p95_ms" doc:"95th percentile response time, in milliseconds (t-digest estimate)."`
	P99Ms        float64   `json:"p99_ms" doc:"99th percentile response time, in milliseconds (t-digest estimate)."`
	Apdex        *float64  `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1, scored as the range's; null without requests."`
	first        time.Time // start of the first bucket with data, zero without any
}

// summaryScope is what a summary window is read with: the tenant filter
// (app included), the same filter without excluded endpoints, the endpoint
// rules and the Apdex thresholds.
type summaryScope struct {
	rules      metricRules
	thresholds apdexThresholds
	tenant     string
	targs      []any
	where      string
	args       []any
}

// totals reads the summary totals of w.
func (s *Service) totals(ctx context.Context, sc summaryScope, w window) (summaryTotals, error) {
	t := summaryTotals{From: w.from, To: w.to}
	var q []float32
	err := s.ch.QueryRow(ctx, fmt.Sprintf(`
		SELECT sum(requests), sum(client_errors), sum(server_errors), %s, min(bucket)
		FROM %s WHERE %s AND bucket >= ? AND bucket < ?`, quantiles, w.table, sc.where),
		append(append([]any{}, sc.args...), w.from, w.to)...).Scan(&t.Requests, &t.ClientErrors, &t.ServerErrors, &q, &t.first)
	if err != nil {
		return t, internalError("summary", err)
	}
	if t.Requests == 0 {
		t.first = time.Time{}
		return t, nil
	}
	expected, err := s.expectedErrors(ctx, sc.rules, sc.tenant, sc.targs, w.from, w.to, "''")
	if err != nil {
		return t, err
	}
	expected[""].subtract(&t.ClientErrors, &t.ServerErrors)
	apdex, err := s.apdex(ctx, sc.thresholds, sc.where+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, sc.args...), w.from, w.to), "''")
	if err != nil {
		return t, err
	}
	t.ErrorRate = float64(t.ClientErrors+t.ServerErrors) / float64(t.Requests)
	t.P50Ms, t.P95Ms, t.P99Ms = quantile(q, 0), quantile(q, 3), quantile(q, 4)
	t.Apdex = apdex[""].score()
	t.first = t.first.UTC()
	return t, nil
}

func (s *Service) summary(ctx context.Context, in *appRangeInput) (*summaryOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	now := s.now()
	w, err := resolveWindow(in.Range, now)
	if err != nil {
		return nil, err
	}
	var sc summaryScope
	if sc.rules, err = s.endpointRules(ctx, p.ProjectID); err != nil {
		return nil, err
	}
	sc.tenant, sc.targs = tenantFilter(p.ProjectID, in.Env)
	if sc.tenant, sc.targs, err = withApp(sc.tenant, sc.targs, in.App); err != nil {
		return nil, err
	}
	sc.where, sc.args = sc.rules.withoutExcluded(sc.tenant, sc.targs)
	if sc.thresholds, err = s.apdexThresholds(ctx, p.ProjectID); err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	cur, err := s.totals(qctx, sc, w)
	if err != nil {
		return nil, err
	}
	var current uint64
	lastMinute := now.UTC().Truncate(time.Minute).Add(-time.Minute)
	err = s.ch.QueryRow(qctx, `SELECT sum(requests) FROM api_requests_1m WHERE `+sc.where+` AND bucket = ?`,
		append(append([]any{}, sc.args...), lastMinute)...).Scan(&current)
	if err != nil {
		return nil, internalError("summary current rate", err)
	}
	prev, err := s.totals(qctx, sc, w.previous())
	if err != nil {
		return nil, err
	}
	out := &summaryOutput{}
	b := &out.Body
	b.Range, b.From, b.To = w.name, w.from, w.to
	b.Requests, b.ClientErrors, b.ServerErrors = cur.Requests, cur.ClientErrors, cur.ServerErrors
	b.ErrorRate, b.P50Ms, b.P95Ms, b.P99Ms = cur.ErrorRate, cur.P50Ms, cur.P95Ms, cur.P99Ms
	b.RequestsPerMinute = perMinute(cur.Requests, w, now, cur.first)
	b.CurrentPerMinute = float64(current)
	b.Apdex = cur.Apdex
	if prev.Requests > 0 {
		b.Previous = &prev
	}
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
	App   string `query:"app" format:"uuid" doc:"App id; empty means every app of the project. An app of another project matches nothing."`
	Limit int    `query:"limit" minimum:"1" maximum:"500" default:"100" doc:"Most endpoints to list, by requests."`
}

type endpoint struct {
	AppID        string   `json:"app_id" format:"uuid" doc:"The app that serves the endpoint."`
	Method       string   `json:"method" doc:"HTTP method of the endpoint, upper case."`
	Path         string   `json:"path" doc:"Route template of the endpoint, e.g. /orders/{id}."`
	Requests     uint64   `json:"requests" doc:"Requests in the range."`
	ClientErrors uint64   `json:"client_errors" doc:"4xx responses, expected status codes of the endpoint left out."`
	ServerErrors uint64   `json:"server_errors" doc:"5xx responses, expected status codes of the endpoint left out."`
	ErrorRate    float64  `json:"error_rate" doc:"(client_errors + server_errors) / requests; 0 without requests."`
	P50Ms        float64  `json:"p50_ms" doc:"Median response time, in milliseconds."`
	P95Ms        float64  `json:"p95_ms" doc:"95th percentile response time, in milliseconds."`
	TotalTimeMs  float64  `json:"total_time_ms" doc:"Sum of the response times of the range's requests, in milliseconds (requests × average): where the API spends its time."`
	Apdex        *float64 `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1 against the endpoint's latency threshold (else its app's, else 500 ms), unexpected 5xx responses counted as frustrated; null without requests."`
	// DiscoveredOnly marks a route an app declared in its metadata that had
	// no traffic in the range; its counts are zero.
	DiscoveredOnly bool `json:"discovered_only" doc:"True for a route an app declared (POST /v1/metadata) without traffic in the range; its counts are zero and it is listed after the endpoints with traffic."`
}

type endpointsOutput struct {
	Body struct {
		Endpoints []endpoint `json:"endpoints" doc:"Endpoints (one per app, method and path) by requests, most first, then routes discovered without traffic; endpoints excluded from metrics are left out."`
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
	tenant, targs, err = withApp(tenant, targs, in.App)
	if err != nil {
		return nil, err
	}
	where, args := rules.withoutExcluded(tenant, targs)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	expected, err := s.expectedErrors(qctx, rules, tenant, targs, w.from, w.to, endpointKeyExpr)
	if err != nil {
		return nil, err
	}
	thresholds, err := s.apdexThresholds(ctx, p.ProjectID)
	if err != nil {
		return nil, err
	}
	apdex, err := s.apdex(qctx, thresholds, where+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, args...), w.from, w.to), endpointKeyExpr)
	if err != nil {
		return nil, err
	}
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT app_id, method, path, sum(requests) AS total, sum(client_errors), sum(server_errors), sum(latency_sum_ms), %s
		FROM %s WHERE %s AND bucket >= ? AND bucket < ?
		GROUP BY app_id, method, path ORDER BY total DESC, path, method, app_id LIMIT ?`, quantiles, w.table, where),
		append(args, w.from, w.to, in.Limit)...)
	if err != nil {
		return nil, internalError("endpoints", err)
	}
	defer func() { _ = rows.Close() }()
	out := &endpointsOutput{}
	out.Body.Endpoints = []endpoint{}
	for rows.Next() {
		var (
			e   endpoint
			app uuid.UUID
			q   []float32
		)
		if err := rows.Scan(&app, &e.Method, &e.Path, &e.Requests, &e.ClientErrors, &e.ServerErrors, &e.TotalTimeMs, &q); err != nil {
			return nil, internalError("endpoints", err)
		}
		e.AppID = app.String()
		key := endpointRowKey(e.AppID, e.Method, e.Path)
		expected[key].subtract(&e.ClientErrors, &e.ServerErrors)
		if e.Requests > 0 {
			e.ErrorRate = float64(e.ClientErrors+e.ServerErrors) / float64(e.Requests)
		}
		e.P50Ms, e.P95Ms = quantile(q, 0), quantile(q, 3)
		e.Apdex = apdex[key].score()
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
		out.Body.Endpoints = withDiscovered(out.Body.Endpoints, routes, rules, in.App, in.Limit)
	}
	return out, nil
}

// endpointKeyExpr keys the per-endpoint reads of the endpoints list on the
// app, method and path of a row, as endpointRowKey does in Go.
const endpointKeyExpr = "concat(toString(app_id), ' ', method, ' ', path)"

// endpointRowKey is endpointKeyExpr of an endpoint.
func endpointRowKey(app, method, path string) string {
	return app + " " + method + " " + path
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
	SpanID        string            `json:"span_id" doc:"Span id (16 lowercase hex characters)."`
	ParentSpanID  string            `json:"parent_span_id" doc:"Parent span id; empty for a root span."`
	Name          string            `json:"name" doc:"Span name, e.g. GET /orders/{id} or SELECT orders."`
	Kind          string            `json:"kind" doc:"OpenTelemetry span kind: server, client, internal, producer or consumer."`
	ServiceName   string            `json:"service_name" doc:"Service that recorded the span."`
	Start         time.Time         `json:"start" doc:"Start time of the span."`
	DurationMs    float64           `json:"duration_ms" doc:"Duration, in milliseconds."`
	Status        string            `json:"status" doc:"Span status: ok, error or unset."`
	StatusCode    uint16            `json:"status_code" doc:"HTTP status code of an HTTP span; 0 otherwise."`
	StatusMessage string            `json:"status_message" doc:"Status description, e.g. why the span failed; empty when none was reported."`
	Attributes    map[string]string `json:"attributes" doc:"Span attributes, as strings."`
	Events        []spanEventOut    `json:"events" doc:"Timestamped span events, oldest first, e.g. an exception event with exception.type, exception.message and exception.stacktrace attributes."`
	Links         []spanLinkOut     `json:"links" doc:"Spans this span links to."`
}

type spanEventOut struct {
	Time       time.Time         `json:"time" doc:"When the event happened (nanosecond precision)."`
	Name       string            `json:"name" doc:"Event name, e.g. exception."`
	Attributes map[string]string `json:"attributes" doc:"Event attributes, as strings."`
}

type spanLinkOut struct {
	TraceID string `json:"trace_id" doc:"Trace id of the linked span."`
	SpanID  string `json:"span_id" doc:"Span id of the linked span."`
}

type traceLog struct {
	Timestamp  time.Time         `json:"timestamp" doc:"When the log record was emitted."`
	Level      string            `json:"level" doc:"Log level, e.g. INFO, WARNING, ERROR."`
	Message    string            `json:"message" doc:"Log message."`
	LoggerName string            `json:"logger_name" doc:"Logger that emitted the record, e.g. apilens.exception; empty when not reported."`
	SpanID     string            `json:"span_id" doc:"Span the record was emitted in; empty when none."`
	Payload    string            `json:"payload" doc:"Structured payload of the record; for an apilens.exception log, the full exception (type, message, frames and chained causes), at most 64 KiB with head and tail kept."`
	Attributes map[string]string `json:"attributes" doc:"Log attributes, as strings, e.g. exception.type, exception.message, exception.chain_depth."`
}

// Trace read limits: a trace answers at most this many spans and logs, and
// sets truncated when either was cut.
const (
	maxTraceSpans = 10000
	maxTraceLogs  = 2000
)

type traceOutput struct {
	Body struct {
		TraceID   string     `json:"trace_id" doc:"The trace id asked for."`
		Spans     []spanOut  `json:"spans" doc:"Spans of the trace in the project, oldest first (at most 10000)."`
		Logs      []traceLog `json:"logs" doc:"Log records correlated with the trace, oldest first (at most 2000)."`
		Truncated bool       `json:"truncated" doc:"True when the trace had more than 10000 spans or 2000 logs and the rest were left out."`
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
	out.Body.Spans, out.Body.Logs, out.Body.Truncated, err = s.traceSpansAndLogs(qctx, p.ProjectID, in.TraceID)
	if err != nil {
		return nil, err
	}
	if len(out.Body.Spans) == 0 && len(out.Body.Logs) == 0 {
		return nil, huma.Error404NotFound("no spans or logs for this trace in the project")
	}
	return out, nil
}

// traceSpansAndLogs reads the spans (at most maxTraceSpans) and correlated
// logs (at most maxTraceLogs) of one trace of a project, oldest first, with
// span status messages, events and links and log payloads and attributes.
// truncated reports that either list was cut at its limit.
func (s *Service) traceSpansAndLogs(ctx context.Context, project uuid.UUID, traceID string) (spans []spanOut, logs []traceLog, truncated bool, err error) {
	spans, logs = []spanOut{}, []traceLog{}
	// One row past the limit tells a full trace from a cut one.
	rows, err := s.ch.Query(ctx, `
		SELECT span_id, parent_span_id, name, kind, service_name, timestamp, duration_ms, status, status_code,
		       status_message, attributes, events.time, events.name, events.attributes, links.trace_id, links.span_id
		FROM api_spans WHERE project_id = ? AND trace_id = ? ORDER BY timestamp, span_id LIMIT ?`,
		project, traceID, maxTraceSpans+1)
	if err != nil {
		return nil, nil, false, internalError("trace spans", err)
	}
	for rows.Next() {
		var (
			sp                    spanOut
			eventTimes            []time.Time
			eventNames            []string
			eventAttrs            []map[string]string
			linkTraces, linkSpans []string
		)
		if err := rows.Scan(&sp.SpanID, &sp.ParentSpanID, &sp.Name, &sp.Kind, &sp.ServiceName, &sp.Start, &sp.DurationMs,
			&sp.Status, &sp.StatusCode, &sp.StatusMessage, &sp.Attributes, &eventTimes, &eventNames, &eventAttrs,
			&linkTraces, &linkSpans); err != nil {
			_ = rows.Close()
			return nil, nil, false, internalError("trace spans", err)
		}
		sp.Attributes = nonNilAttrs(sp.Attributes)
		sp.Events = zipSpanEvents(eventTimes, eventNames, eventAttrs)
		sp.Links = zipSpanLinks(linkTraces, linkSpans)
		spans = append(spans, sp)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, false, internalError("trace spans", err)
	}
	spans, spansCut := capTrace(spans, maxTraceSpans)

	lrows, err := s.ch.Query(ctx, `
		SELECT timestamp, level, message, logger_name, span_id, payload, attributes
		FROM api_logs WHERE project_id = ? AND trace_id = ? ORDER BY timestamp LIMIT ?`,
		project, traceID, maxTraceLogs+1)
	if err != nil {
		return nil, nil, false, internalError("trace logs", err)
	}
	defer func() { _ = lrows.Close() }()
	for lrows.Next() {
		var l traceLog
		if err := lrows.Scan(&l.Timestamp, &l.Level, &l.Message, &l.LoggerName, &l.SpanID, &l.Payload, &l.Attributes); err != nil {
			return nil, nil, false, internalError("trace logs", err)
		}
		l.Attributes = nonNilAttrs(l.Attributes)
		logs = append(logs, l)
	}
	if err := lrows.Err(); err != nil {
		return nil, nil, false, internalError("trace logs", err)
	}
	logs, logsCut := capTrace(logs, maxTraceLogs)
	return spans, logs, spansCut || logsCut, nil
}

// capTrace cuts rows to limit and reports whether anything was cut.
func capTrace[T any](rows []T, limit int) ([]T, bool) {
	if len(rows) > limit {
		return rows[:limit], true
	}
	return rows, false
}

// zipSpanEvents joins the parallel arrays of the Nested events column into
// events; a ragged row keeps only the complete events.
func zipSpanEvents(times []time.Time, names []string, attrs []map[string]string) []spanEventOut {
	n := min(len(times), len(names), len(attrs))
	out := make([]spanEventOut, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, spanEventOut{Time: times[i].In(time.UTC), Name: names[i], Attributes: nonNilAttrs(attrs[i])})
	}
	return out
}

// zipSpanLinks joins the element arrays of the links tuple column.
func zipSpanLinks(traces, spans []string) []spanLinkOut {
	n := min(len(traces), len(spans))
	out := make([]spanLinkOut, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, spanLinkOut{TraceID: traces[i], SpanID: spans[i]})
	}
	return out
}

func nonNilAttrs(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
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
