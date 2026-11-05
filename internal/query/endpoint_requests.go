package query

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Endpoint detail, Requests tab: totals, requests per minute, the
// success / client error / server error split over time and the top
// consumers of one endpoint (method + route template).
//
// Without a status or consumer filter the totals and the series read the
// 1m/1h rollup of the range; those filters are not rollup dimensions, so
// with either of them set both read raw api_requests, still pruned by the
// (project_id, app_id, hour, environment, path, method) sort key. The
// consumer top-N always reads raw rows.
//
// Benchmark (issue #571, budget p95 < 300 ms on 10M rows): 10M rows of 24h
// traffic over 40 endpoints and 5,000 consumers, range=24h, single local
// ClickHouse (colima, 2 vCPU / 4 GB), 40 calls each: unfiltered p95 43 ms,
// status=5xx p95 40 ms, consumer=<id> p95 39 ms. Reproduce with
// APILENS_BENCH=1 go test -tags integration -run TestEndpointRequestsBenchmark.

// topConsumers is how many consumers the detail lists.
const topConsumers = 10

type endpointRequestsInput struct {
	RangeInput
	Method   string `path:"method" pattern:"^[A-Za-z]{1,16}$" example:"GET" doc:"HTTP method, e.g. GET (case-insensitive)."`
	Path     string `path:"path" minLength:"1" maxLength:"1024" example:"/orders/{id}" doc:"Route template, URL-encoded as one path segment, e.g. %2Forders%2F%7Bid%7D for /orders/{id}."`
	Status   string `query:"status" enum:"all,2xx,3xx,4xx,5xx" default:"all" doc:"Only requests with a status code in this class."`
	Consumer string `query:"consumer" maxLength:"256" doc:"Only requests from this consumer id; empty means all."`
}

// StatusSplit counts requests by outcome. Exported so Huma reads the fields
// of the types embedding it.
type StatusSplit struct {
	Requests     uint64 `json:"requests" doc:"All requests."`
	Successful   uint64 `json:"successful" doc:"Requests with a status code below 400."`
	ClientErrors uint64 `json:"client_errors" doc:"Requests with a 4xx status code."`
	ServerErrors uint64 `json:"server_errors" doc:"Requests with a 5xx status code."`
}

type endpointRequestsSummary struct {
	StatusSplit
	RequestsPerMinute float64 `json:"requests_per_minute" doc:"requests / minutes of the range."`
}

type endpointRequestsPoint struct {
	TS time.Time `json:"ts" doc:"Start of the bucket."`
	StatusSplit
}

type endpointConsumer struct {
	ConsumerID   string `json:"consumer_id" doc:"Consumer id the SDK reported."`
	ConsumerName string `json:"consumer_name" doc:"Most recently reported name of the consumer."`
	StatusSplit
}

type endpointRequestsOutput struct {
	Body struct {
		Method        string                  `json:"method" doc:"HTTP method of the endpoint, upper case."`
		Path          string                  `json:"path" doc:"Route template of the endpoint, e.g. /orders/{id}."`
		Range         string                  `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From          time.Time               `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To            time.Time               `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds int                     `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Summary       endpointRequestsSummary `json:"summary" doc:"Requests of the whole range by outcome."`
		Points        []endpointRequestsPoint `json:"points" doc:"One point per bucket of the range, zero-filled."`
		Consumers     []endpointConsumer      `json:"consumers" doc:"Top consumers by requests (at most 10); requests without a consumer are left out."`
	}
}

// endpointFilter is the WHERE clause shared by the queries of the endpoint
// detail. ts names the time column of the table read; raw adds the status
// and consumer filters, which only raw rows can answer.
func endpointFilter(project uuid.UUID, in *endpointRequestsInput, method, ts string, w window, raw bool) (string, []any) {
	where, args := tenantFilter(project, in.Env)
	clauses := []string{where, "method = ?", "path = ?", ts + " >= ?", ts + " < ?"}
	args = append(args, method, in.Path, w.from, w.to)
	if raw {
		if r, ok := statusClasses[in.Status]; ok {
			clauses = append(clauses, "status_code BETWEEN ? AND ?")
			args = append(args, r[0], r[1])
		}
		if in.Consumer != "" {
			clauses = append(clauses, "consumer_id = ?")
			args = append(args, in.Consumer)
		}
	}
	return strings.Join(clauses, " AND "), args
}

// Status split aggregates over raw rows and over the rollups, in
// StatusSplit field order.
const (
	rawSplit  = `count() AS n, countIf(status_code < 400), countIf(status_code >= 400 AND status_code < 500), countIf(status_code >= 500)`
	rollSplit = `sum(requests) AS n, toUInt64(n - sum(client_errors) - sum(server_errors)), sum(client_errors), sum(server_errors)`
)

func (s *Service) endpointRequests(ctx context.Context, in *endpointRequestsInput) (*endpointRequestsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	method := strings.ToUpper(in.Method)
	seconds := int(w.bucket.Seconds())
	_, statusFiltered := statusClasses[in.Status]
	raw := statusFiltered || in.Consumer != ""
	table, ts, split := w.table, "bucket", rollSplit
	if raw {
		table, ts, split = "api_requests", "timestamp", rawSplit
	}
	where, args := endpointFilter(p.ProjectID, in, method, ts, w, raw)

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &endpointRequestsOutput{}
	b := &out.Body
	b.Method, b.Path, b.Range, b.From, b.To, b.BucketSeconds = method, in.Path, w.name, w.from, w.to, seconds

	// table, ts and the bucket width come from fixed values, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(%s, INTERVAL %d SECOND) AS t, %s
		FROM %s WHERE %s GROUP BY t ORDER BY t`, ts, seconds, split, table, where), args...)
	if err != nil {
		return nil, internalError("endpoint timeseries", err)
	}
	got := map[int64]StatusSplit{}
	for rows.Next() {
		var (
			t  time.Time
			sp StatusSplit
		)
		if err := rows.Scan(&t, &sp.Requests, &sp.Successful, &sp.ClientErrors, &sp.ServerErrors); err != nil {
			_ = rows.Close()
			return nil, internalError("endpoint timeseries", err)
		}
		got[t.UTC().Unix()] = sp
		b.Summary.Requests += sp.Requests
		b.Summary.Successful += sp.Successful
		b.Summary.ClientErrors += sp.ClientErrors
		b.Summary.ServerErrors += sp.ServerErrors
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("endpoint timeseries", err)
	}
	b.Summary.RequestsPerMinute = float64(b.Summary.Requests) / w.to.Sub(w.from).Minutes()
	b.Points = make([]endpointRequestsPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		b.Points = append(b.Points, endpointRequestsPoint{TS: t, StatusSplit: got[t.Unix()]})
	}

	where, args = endpointFilter(p.ProjectID, in, method, "timestamp", w, true)
	crows, err := s.ch.Query(qctx, `
		SELECT consumer_id, argMax(consumer_name, timestamp), `+rawSplit+`
		FROM api_requests WHERE `+where+` AND consumer_id != ''
		GROUP BY consumer_id ORDER BY n DESC, consumer_id LIMIT ?`, append(args, topConsumers)...)
	if err != nil {
		return nil, internalError("endpoint consumers", err)
	}
	defer func() { _ = crows.Close() }()
	b.Consumers = []endpointConsumer{}
	for crows.Next() {
		var c endpointConsumer
		if err := crows.Scan(&c.ConsumerID, &c.ConsumerName, &c.Requests, &c.Successful, &c.ClientErrors, &c.ServerErrors); err != nil {
			return nil, internalError("endpoint consumers", err)
		}
		b.Consumers = append(b.Consumers, c)
	}
	return out, crows.Err()
}
