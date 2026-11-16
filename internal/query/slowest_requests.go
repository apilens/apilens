package query

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Performance page, "Slowest requests" (#1001): the single slowest raw
// requests of a range, so "why is it slow" ends at a request rather than at
// a percentile. Endpoints excluded from metrics are left out, as they are
// from the rest of the Performance report.

// maxSlowestRequests is the most requests the list answers.
const maxSlowestRequests = 50

func registerSlowestRequests(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-slowest-requests", Method: http.MethodGet, Path: "/api/v1/requests/slowest",
		Summary: "Slowest requests: the requests of the range with the longest response time",
		Description: "The raw requests of the range (or one environment, or one app) with the longest response time, slowest first " +
			"(ties: newest first). Endpoints excluded from metrics are left out." + readAccess,
		Tags: []string{"Dashboard"}, Security: security,
	}, s.slowestRequests)
}

type slowestRequestsInput struct {
	RangeInput
	App   string `query:"app" format:"uuid" doc:"App id; empty means every app of the project. An app of another project matches nothing."`
	Limit int    `query:"limit" minimum:"1" maximum:"50" default:"10" doc:"Most requests to list."`
}

type slowestRequestsOutput struct {
	Body struct {
		Requests []requestRow `json:"requests" doc:"Slowest first, then newest first; each id opens GET /api/v1/requests/{id}."`
	}
}

// slowestRequestsQuery is the SQL and arguments of the slowest-requests
// read: the scope (tenant, app, excluded endpoints) and the range, ordered
// by response time.
func slowestRequestsQuery(project uuid.UUID, in *slowestRequestsInput, rules metricRules, w window) (string, []any, error) {
	where, args := tenantFilter(project, in.Env)
	where, args, err := withApp(where, args, in.App)
	if err != nil {
		return "", nil, err
	}
	where, args = rules.withoutExcluded(where, args)
	limit := min(max(in.Limit, 1), maxSlowestRequests)
	clauses := []string{where, "timestamp >= ?", "timestamp < ?"}
	args = append(args, w.from, w.to, limit)
	return `
		SELECT timestamp, app_id, method, path, raw_path, status_code, response_time_ms, request_size, response_size,
		       environment, ip_address, consumer_id, consumer_name, consumer_group, sampled, trace_id, span_id
		FROM api_requests WHERE ` + strings.Join(clauses, " AND ") + `
		ORDER BY response_time_ms DESC, timestamp DESC, trace_id DESC LIMIT ?`, args, nil
}

func (s *Service) slowestRequests(ctx context.Context, in *slowestRequestsInput) (*slowestRequestsOutput, error) {
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
	query, args, err := slowestRequestsQuery(p.ProjectID, in, rules, w)
	if err != nil {
		return nil, err
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, query, args...)
	if err != nil {
		return nil, internalError("slowest requests", err)
	}
	defer func() { _ = rows.Close() }()
	out := &slowestRequestsOutput{}
	out.Body.Requests = []requestRow{}
	for rows.Next() {
		var (
			r       requestRow
			app     uuid.UUID
			sampled uint8
			span    string
		)
		if err := rows.Scan(&r.Timestamp, &app, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
			&r.RequestSize, &r.ResponseSize, &r.Environment, &r.IPAddress, &r.ConsumerID, &r.ConsumerName,
			&r.ConsumerGroup, &sampled, &r.TraceID, &span); err != nil {
			return nil, internalError("slowest requests", err)
		}
		r.AppID, r.Sampled = app.String(), sampled != 0
		r.ID = requestID{ms: r.Timestamp.UnixMilli(), traceID: r.TraceID, spanID: span}.encode()
		out.Body.Requests = append(out.Body.Requests, r)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("slowest requests", err)
	}
	return out, nil
}
