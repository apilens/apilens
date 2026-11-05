package query

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"
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
	Requests uint64  `json:"requests"`
	AvgMs    float64 `json:"avg_ms"`
	MaxMs    float64 `json:"max_ms"`
	P50Ms    float64 `json:"p50_ms"`
	P75Ms    float64 `json:"p75_ms"`
	P90Ms    float64 `json:"p90_ms"`
	P95Ms    float64 `json:"p95_ms"`
	P99Ms    float64 `json:"p99_ms"`
}

type latencyPoint struct {
	TS       time.Time `json:"ts" doc:"Start of the bucket."`
	Requests uint64    `json:"requests"`
	P50Ms    float64   `json:"p50_ms"`
	P75Ms    float64   `json:"p75_ms"`
	P95Ms    float64   `json:"p95_ms"`
}

type latencyBucket struct {
	FromMs float64  `json:"from_ms" doc:"Inclusive lower edge."`
	ToMs   *float64 `json:"to_ms,omitempty" doc:"Exclusive upper edge; absent on the last, open bucket."`
	Count  uint64   `json:"count"`
}

type endpointLatencyOutput struct {
	Body struct {
		Method        string          `json:"method"`
		Path          string          `json:"path"`
		Range         string          `json:"range"`
		From          time.Time       `json:"from"`
		To            time.Time       `json:"to"`
		BucketSeconds int             `json:"bucket_seconds"`
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

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &endpointLatencyOutput{}
	b := &out.Body
	b.Method, b.Path, b.Range, b.From, b.To, b.BucketSeconds = method, in.Path, w.name, w.from, w.to, seconds

	// table, ts, agg and the bucket width come from fixed values, never from input.
	var (
		sum, maxMs float64
		q          []float32
	)
	if err := s.ch.QueryRow(qctx, fmt.Sprintf(`SELECT %s FROM %s WHERE %s`, agg, table, where), args...).
		Scan(&b.Summary.Requests, &sum, &maxMs, &q); err != nil {
		return nil, internalError("endpoint latency", err)
	}
	if b.Summary.Requests > 0 {
		b.Summary.AvgMs = round2(sum / float64(b.Summary.Requests))
		b.Summary.MaxMs = round2(maxMs)
		b.Summary.P50Ms, b.Summary.P75Ms, b.Summary.P90Ms = quantile(q, 0), quantile(q, 1), quantile(q, 2)
		b.Summary.P95Ms, b.Summary.P99Ms = quantile(q, 3), quantile(q, 4)
	}

	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(%s, INTERVAL %d SECOND) AS t, %s
		FROM %s WHERE %s GROUP BY t ORDER BY t`, ts, seconds, agg, table, where), args...)
	if err != nil {
		return nil, internalError("endpoint latency trend", err)
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
			return nil, internalError("endpoint latency trend", err)
		}
		if pt.Requests > 0 {
			pt.P50Ms, pt.P75Ms, pt.P95Ms = quantile(bq, 0), quantile(bq, 1), quantile(bq, 3)
		}
		got[t.UTC().Unix()] = pt
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("endpoint latency trend", err)
	}
	b.Points = make([]latencyPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		pt := got[t.Unix()]
		pt.TS = t
		b.Points = append(b.Points, pt)
	}

	where, args = endpointFilter(p.ProjectID, in, method, "timestamp", w, true)
	hrows, err := s.ch.Query(qctx, `
		SELECT `+bucketIndex("response_time_ms", latencyEdgesMs)+` AS i, count()
		FROM api_requests WHERE `+where+` GROUP BY i`, args...)
	if err != nil {
		return nil, internalError("endpoint latency histogram", err)
	}
	defer func() { _ = hrows.Close() }()
	counts := make([]uint64, len(latencyEdgesMs)+1)
	for hrows.Next() {
		var (
			i uint64
			n uint64
		)
		if err := hrows.Scan(&i, &n); err != nil {
			return nil, internalError("endpoint latency histogram", err)
		}
		counts[i] += n
	}
	if err := hrows.Err(); err != nil {
		return nil, internalError("endpoint latency histogram", err)
	}
	b.Histogram = make([]latencyBucket, len(counts))
	for i, n := range counts {
		bk := latencyBucket{Count: n}
		if i > 0 {
			bk.FromMs = latencyEdgesMs[i-1]
		}
		if i < len(latencyEdgesMs) {
			bk.ToMs = &latencyEdgesMs[i]
		}
		b.Histogram[i] = bk
	}
	return out, nil
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
