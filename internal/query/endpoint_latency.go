package query

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Endpoint detail, Response time tab: latency percentiles of the range, a
// p50/p75/p95 trend and a response-time histogram of one endpoint.
//
// Like the Requests tab, the summary and the trend read the 1m/1h rollup
// unless a status or consumer filter forces raw api_requests. The histogram
// always reads raw rows (the rollups keep no distribution beyond the digest).

// latencyEdgesMs are the response-time histogram bucket edges in
// milliseconds: a 1-2-5 log series from 1 ms to 10 s. Bucket i covers
// [edge[i-1], edge[i]); the first bucket starts at 0 and the last one,
// [10000, +inf), is open.
var latencyEdgesMs = []float64{1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000}

// LatencySummary are the response-time statistics of the range. Exported
// so Huma reads the fields of the types embedding it.
type LatencySummary struct {
	Requests uint64   `json:"requests" doc:"Requests in the range."`
	AvgMs    float64  `json:"avg_ms" doc:"Mean response time, in milliseconds."`
	MaxMs    float64  `json:"max_ms" doc:"Slowest response time, in milliseconds."`
	P50Ms    float64  `json:"p50_ms" doc:"Median response time, in milliseconds."`
	P75Ms    float64  `json:"p75_ms" doc:"75th percentile response time, in milliseconds."`
	P90Ms    float64  `json:"p90_ms" doc:"90th percentile response time, in milliseconds."`
	P95Ms    float64  `json:"p95_ms" doc:"95th percentile response time, in milliseconds."`
	P99Ms    float64  `json:"p99_ms" doc:"99th percentile response time, in milliseconds."`
	Apdex    *float64 `json:"apdex" required:"true" nullable:"true" doc:"Apdex score from 0 to 1 over raw requests, against the endpoint's latency threshold (else its app's, else 500 ms); null without requests."`
}

type latencyPoint struct {
	TS       time.Time `json:"ts" doc:"Start of the bucket."`
	Requests uint64    `json:"requests" doc:"Requests in the bucket."`
	P50Ms    float64   `json:"p50_ms" doc:"Median response time of the bucket, in milliseconds; 0 without requests."`
	P75Ms    float64   `json:"p75_ms" doc:"75th percentile response time of the bucket, in milliseconds; 0 without requests."`
	P95Ms    float64   `json:"p95_ms" doc:"95th percentile response time of the bucket, in milliseconds; 0 without requests."`
}

type latencyBucket struct {
	FromMs float64  `json:"from_ms" doc:"Inclusive lower edge."`
	ToMs   *float64 `json:"to_ms,omitempty" doc:"Exclusive upper edge; absent on the last, open bucket."`
	Count  uint64   `json:"count" doc:"Requests whose response time falls in the bucket."`
}

type endpointLatencyOutput struct {
	Body struct {
		Method        string          `json:"method" doc:"HTTP method of the endpoint, upper case."`
		Path          string          `json:"path" doc:"Route template of the endpoint, e.g. /orders/{id}."`
		Range         string          `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From          time.Time       `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To            time.Time       `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds int             `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Summary       LatencySummary  `json:"summary" doc:"Percentiles are t-digest estimates."`
		Points        []latencyPoint  `json:"points" doc:"One point per bucket of the range, zero-filled."`
		Histogram     []latencyBucket `json:"histogram" doc:"Response-time histogram over raw requests, always 14 log-spaced buckets with edges (ms) 0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, +inf; empty buckets have count 0."`
	}
}

// Latency aggregates over raw rows and over the rollups: requests, sum,
// max and the quantiles at the levels of the rollup digest.
const (
	rawLatency  = `count(), sum(response_time_ms), max(response_time_ms), quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99)(response_time_ms)`
	rollLatency = `sum(requests), sum(latency_sum_ms), max(latency_max_ms), ` + quantiles
)

func (s *Service) endpointLatency(ctx context.Context, in *endpointRequestsInput) (*endpointLatencyOutput, error) {
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
	table, ts, agg := w.table, "bucket", rollLatency
	if raw {
		table, ts, agg = "api_requests", "timestamp", rawLatency
	}
	where, args := endpointFilter(p.ProjectID, in, method, ts, w, raw)

	rawWhere, rawArgs := endpointFilter(p.ProjectID, in, method, "timestamp", w, true)

	out := &endpointLatencyOutput{}
	b := &out.Body
	b.Method, b.Path, b.Range, b.From, b.To, b.BucketSeconds = method, in.Path, w.name, w.from, w.to, seconds
	b.Summary, b.Points, b.Histogram, err = s.latencyReport(ctx, p.ProjectID, w, table, ts, agg, where, args, rawWhere, rawArgs)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// latencyReport reads the percentiles, the p50/p75/p95 trend, the Apdex and
// the response-time histogram of a scope. where/args select the scope in
// table (a rollup, or raw api_requests) with ts its time column, agg the
// matching latency aggregates; rawWhere/rawArgs select the same scope in raw
// api_requests rows. Both must bound the window. table, ts and agg come from
// fixed values, never from input.
func (s *Service) latencyReport(ctx context.Context, project uuid.UUID, w window, table, ts, agg, where string, args []any, rawWhere string, rawArgs []any) (LatencySummary, []latencyPoint, []latencyBucket, error) {
	var summary LatencySummary
	seconds := int(w.bucket.Seconds())
	qctx, cancel := queryCtx(ctx)
	defer cancel()

	var (
		sum, maxMs float64
		q          []float32
	)
	if err := s.ch.QueryRow(qctx, fmt.Sprintf(`SELECT %s FROM %s WHERE %s`, agg, table, where), args...).
		Scan(&summary.Requests, &sum, &maxMs, &q); err != nil {
		return summary, nil, nil, internalError("latency", err)
	}
	if summary.Requests > 0 {
		summary.AvgMs = round2(sum / float64(summary.Requests))
		summary.MaxMs = round2(maxMs)
		summary.P50Ms, summary.P75Ms, summary.P90Ms = quantile(q, 0), quantile(q, 1), quantile(q, 2)
		summary.P95Ms, summary.P99Ms = quantile(q, 3), quantile(q, 4)
	}

	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(%s, INTERVAL %d SECOND) AS t, %s
		FROM %s WHERE %s GROUP BY t ORDER BY t`, ts, seconds, agg, table, where), args...)
	if err != nil {
		return summary, nil, nil, internalError("latency trend", err)
	}
	got := map[int64]latencyPoint{}
	for rows.Next() {
		var (
			t          time.Time
			pt         latencyPoint
			bsum, bmax float64
			bq         []float32
		)
		if err := rows.Scan(&t, &pt.Requests, &bsum, &bmax, &bq); err != nil {
			_ = rows.Close()
			return summary, nil, nil, internalError("latency trend", err)
		}
		if pt.Requests > 0 {
			pt.P50Ms, pt.P75Ms, pt.P95Ms = quantile(bq, 0), quantile(bq, 1), quantile(bq, 3)
		}
		got[t.UTC().Unix()] = pt
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return summary, nil, nil, internalError("latency trend", err)
	}
	points := make([]latencyPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		pt := got[t.Unix()]
		pt.TS = t
		points = append(points, pt)
	}

	thresholds, err := s.apdexThresholds(ctx, project)
	if err != nil {
		return summary, nil, nil, err
	}
	apdex, err := s.apdex(qctx, thresholds, rawWhere, rawArgs, "''")
	if err != nil {
		return summary, nil, nil, err
	}
	summary.Apdex = apdex[""].score()
	hrows, err := s.ch.Query(qctx, `
		SELECT `+bucketIndex("response_time_ms", latencyEdgesMs)+` AS i, count()
		FROM api_requests WHERE `+rawWhere+` GROUP BY i`, rawArgs...)
	if err != nil {
		return summary, nil, nil, internalError("latency histogram", err)
	}
	defer func() { _ = hrows.Close() }()
	counts := make([]uint64, len(latencyEdgesMs)+1)
	for hrows.Next() {
		var (
			i uint64
			n uint64
		)
		if err := hrows.Scan(&i, &n); err != nil {
			return summary, nil, nil, internalError("latency histogram", err)
		}
		counts[i] += n
	}
	if err := hrows.Err(); err != nil {
		return summary, nil, nil, internalError("latency histogram", err)
	}
	histogram := make([]latencyBucket, len(counts))
	for i, n := range counts {
		bk := latencyBucket{Count: n}
		if i > 0 {
			bk.FromMs = latencyEdgesMs[i-1]
		}
		if i < len(latencyEdgesMs) {
			bk.ToMs = &latencyEdgesMs[i]
		}
		histogram[i] = bk
	}
	return summary, points, histogram, nil
}

// bucketIndex is the ClickHouse expression of the histogram bucket a value
// of col falls in: the number of edges at or below it, 0..len(edges). The
// edges are fixed in code, never input.
func bucketIndex[T float64 | uint64](col string, edges []T) string {
	lits := make([]string, len(edges))
	for i, e := range edges {
		lits[i] = fmt.Sprint(e)
	}
	return fmt.Sprintf("toUInt64(arrayCount(e -> e <= %s, [%s]))", col, strings.Join(lits, ", "))
}

// round2 rounds v to two decimals, mapping NaN and Inf to 0.
func round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}
