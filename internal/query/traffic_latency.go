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
		Summary: "Response time: percentiles, p50/p75/p95 trend, Apdex and histogram", Tags: []string{"Dashboard"}, Security: security,
	}, s.trafficLatency)
}

type trafficLatencyOutput struct {
	Body struct {
		Range         string          `json:"range"`
		From          time.Time       `json:"from"`
		To            time.Time       `json:"to"`
		BucketSeconds int             `json:"bucket_seconds"`
		Summary       LatencySummary  `json:"summary" doc:"Percentiles are t-digest estimates; apdex scores each request against its endpoint's latency threshold, else its app's, else 500 ms."`
		Points        []latencyPoint  `json:"points" doc:"One point per bucket of the range, zero-filled."`
		Histogram     []latencyBucket `json:"histogram" doc:"Response-time histogram over raw requests, always 14 log-spaced buckets with edges (ms) 0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, +inf; empty buckets have count 0."`
	}
}

func (s *Service) trafficLatency(ctx context.Context, in *RangeInput) (*trafficLatencyOutput, error) {
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
	scope, sargs := rules.withoutExcluded(tenant, targs)
	where, args := scope+" AND bucket >= ? AND bucket < ?", append(append([]any{}, sargs...), w.from, w.to)
	rawWhere, rawArgs := scope+" AND timestamp >= ? AND timestamp < ?", append(append([]any{}, sargs...), w.from, w.to)

	out := &trafficLatencyOutput{}
	b := &out.Body
	b.Range, b.From, b.To, b.BucketSeconds = w.name, w.from, w.to, int(w.bucket.Seconds())
	b.Summary, b.Points, b.Histogram, err = s.latencyReport(ctx, p.ProjectID, w, w.table, "bucket", rollLatency, where, args, rawWhere, rawArgs)
	if err != nil {
		return nil, err
	}
	return out, nil
}
