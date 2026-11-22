package query

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Performance dashboard (Apitally's performance view): the response-time
// percentiles, p50/p75/p95 trend, Apdex and histogram of a whole project,
// the same report the endpoint detail's Response time tab gives for one
// endpoint. Excluded endpoints are left out. The summary and the trend read
// the rollups; the Apdex and the histogram read raw api_requests rows.

func registerTrafficLatency(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "get-traffic-latency", Method: http.MethodGet, Path: "/api/v1/traffic/latency",
		Summary: "Response time: percentiles, p50/p75/p95 trend, Apdex and histogram",
		Description: "Response time of the project (or one environment) over the range: summary percentiles and Apdex, the " +
			"p50/p75/p95 trend per bucket and a fixed 14-bucket histogram over raw requests. Endpoints excluded from metrics are left out; " +
			"app narrows to one app." + readAccess,
		Tags: []string{"Dashboard"}, Security: security,
	}, s.trafficLatency)
}

type trafficLatencyOutput struct {
	Body struct {
		Range         string          `json:"range" doc:"Time range of the response: 1h, 6h, 24h or 7d."`
		From          time.Time       `json:"from" doc:"Start of the range (inclusive, bucket-aligned)."`
		To            time.Time       `json:"to" doc:"End of the range (exclusive, bucket-aligned)."`
		BucketSeconds int             `json:"bucket_seconds" doc:"Width of each series bucket, in seconds."`
		Summary       LatencySummary  `json:"summary" doc:"Percentiles are t-digest estimates; apdex scores each request against its endpoint's latency threshold, else its app's, else 500 ms."`
		Points        []latencyPoint  `json:"points" doc:"One point per bucket of the range, zero-filled."`
		Histogram     []latencyBucket `json:"histogram" doc:"Response-time histogram over raw requests, always 14 log-spaced buckets with edges (ms) 0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, +inf; empty buckets have count 0."`
		Previous      *LatencySummary `json:"previous,omitempty" doc:"The summary over the window of the same length just before the range, the baseline of the comparison on the tiles; left out when that window has no requests."`
	}
}

func (s *Service) trafficLatency(ctx context.Context, in *appRangeInput) (*trafficLatencyOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveTrafficWindow(in.Range, in.From, in.To, s.now())
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
	tenant, targs = withRoute(tenant, targs, in.RouteInput)
	scope, sargs := rules.withoutExcluded(tenant, targs)
	src := sourceOf(w, in.RouteInput)
	agg := rollLatency
	if in.raw() {
		agg = rawLatency
	}
	where, args := scope+" AND "+src.ts+" >= ? AND "+src.ts+" < ?", append(append([]any{}, sargs...), w.from, w.to)
	rawWhere, rawArgs := scope+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, sargs...), w.from, w.to)

	out := &trafficLatencyOutput{}
	b := &out.Body
	b.Range, b.From, b.To, b.BucketSeconds = w.name, w.from, w.to, int(w.bucket.Seconds())
	b.Summary, b.Points, b.Histogram, err = s.latencyReport(ctx, p.ProjectID, w, src.table, src.ts, agg, where, args, rawWhere, rawArgs)
	if err != nil {
		return nil, err
	}
	pw := w.previous()
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	psrc := sourceOf(pw, in.RouteInput)
	prev, err := s.latencySummary(qctx, p.ProjectID, psrc.table, agg,
		scope+" AND "+psrc.ts+" >= ? AND "+psrc.ts+" < ?", append(append([]any{}, sargs...), pw.from, pw.to),
		scope+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, sargs...), pw.from, pw.to))
	if err != nil {
		return nil, err
	}
	if prev.Requests > 0 {
		b.Previous = &prev
	}
	return out, nil
}
