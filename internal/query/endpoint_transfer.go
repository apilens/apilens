package query

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Endpoint detail, Data transferred tab: request (in) and response (out)
// bytes of one endpoint, their totals and averages, a per-bucket bar series
// and size histograms.
//
// The totals and the series read the 1m/1h rollup unless a status or
// consumer filter forces raw api_requests; the histograms always read raw
// rows.

// sizeEdgesBytes are the size histogram bucket edges in bytes, shared by
// request and response sizes: 1 (so [0, 1) holds empty bodies), then
// powers of 4 from 256 B to 4 MiB. Bucket i covers [edge[i-1], edge[i]);
// the first bucket starts at 0 and the last one, [4 MiB, +inf), is open.
var sizeEdgesBytes = []uint64{1, 256, 1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 1 << 20, 4 << 20}

type transferSummary struct {
	Requests         uint64  `json:"requests"`
	RequestBytes     uint64  `json:"request_bytes" doc:"Bytes received in request bodies."`
	ResponseBytes    uint64  `json:"response_bytes" doc:"Bytes sent in response bodies."`
	AvgRequestBytes  float64 `json:"avg_request_bytes"`
	AvgResponseBytes float64 `json:"avg_response_bytes"`
}

type transferPoint struct {
	TS            time.Time `json:"ts" doc:"Start of the bucket."`
	Requests      uint64    `json:"requests"`
	RequestBytes  uint64    `json:"request_bytes"`
	ResponseBytes uint64    `json:"response_bytes"`
}

type sizeBucket struct {
	FromBytes uint64  `json:"from_bytes" doc:"Inclusive lower edge."`
	ToBytes   *uint64 `json:"to_bytes,omitempty" doc:"Exclusive upper edge; absent on the last, open bucket."`
	Count     uint64  `json:"count"`
}

type endpointTransferOutput struct {
	Body struct {
		Method                string          `json:"method"`
		Path                  string          `json:"path"`
		Range                 string          `json:"range"`
		From                  time.Time       `json:"from"`
		To                    time.Time       `json:"to"`
		BucketSeconds         int             `json:"bucket_seconds"`
		Summary               transferSummary `json:"summary"`
		Points                []transferPoint `json:"points" doc:"Bytes in and out per bucket of the range, zero-filled."`
		RequestSizeHistogram  []sizeBucket    `json:"request_size_histogram" doc:"Request body sizes over raw requests, always 10 log-spaced buckets with edges (bytes) 0, 1, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, +inf; empty buckets have count 0."`
		ResponseSizeHistogram []sizeBucket    `json:"response_size_histogram" doc:"Response body sizes over raw requests, always 10 log-spaced buckets with edges (bytes) 0, 1, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, +inf; empty buckets have count 0."`
	}
}

// Byte sums over raw rows and over the rollups, in transferPoint order.
const (
	rawTransfer  = `count(), sum(request_size), sum(response_size)`
	rollTransfer = `sum(requests), sum(request_bytes), sum(response_bytes)`
)

func (s *Service) endpointTransfer(ctx context.Context, in *endpointRequestsInput) (*endpointTransferOutput, error) {
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
	table, ts, agg := w.table, "bucket", rollTransfer
	if raw {
		table, ts, agg = "api_requests", "timestamp", rawTransfer
	}
	where, args := endpointFilter(p.ProjectID, in, method, ts, w, raw)

	qctx, cancel := queryCtx(ctx)
	defer cancel()
	out := &endpointTransferOutput{}
	b := &out.Body
	b.Method, b.Path, b.Range, b.From, b.To, b.BucketSeconds = method, in.Path, w.name, w.from, w.to, seconds

	// table, ts, agg and the bucket width come from fixed values, never from input.
	rows, err := s.ch.Query(qctx, fmt.Sprintf(`
		SELECT toStartOfInterval(%s, INTERVAL %d SECOND) AS t, %s
		FROM %s WHERE %s GROUP BY t ORDER BY t`, ts, seconds, agg, table, where), args...)
	if err != nil {
		return nil, internalError("endpoint transfer", err)
	}
	got := map[int64]transferPoint{}
	for rows.Next() {
		var pt transferPoint
		if err := rows.Scan(&pt.TS, &pt.Requests, &pt.RequestBytes, &pt.ResponseBytes); err != nil {
			_ = rows.Close()
			return nil, internalError("endpoint transfer", err)
		}
		got[pt.TS.UTC().Unix()] = pt
		b.Summary.Requests += pt.Requests
		b.Summary.RequestBytes += pt.RequestBytes
		b.Summary.ResponseBytes += pt.ResponseBytes
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalError("endpoint transfer", err)
	}
	if n := b.Summary.Requests; n > 0 {
		b.Summary.AvgRequestBytes = round2(float64(b.Summary.RequestBytes) / float64(n))
		b.Summary.AvgResponseBytes = round2(float64(b.Summary.ResponseBytes) / float64(n))
	}
	b.Points = make([]transferPoint, 0, int(w.to.Sub(w.from)/w.bucket))
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		pt := got[t.Unix()]
		pt.TS = t
		b.Points = append(b.Points, pt)
	}

	// One scan for both histograms: count per (request bucket, response bucket).
	where, args = endpointFilter(p.ProjectID, in, method, "timestamp", w, true)
	hrows, err := s.ch.Query(qctx, `
		SELECT `+bucketIndex("request_size", sizeEdgesBytes)+` AS ri,
		       `+bucketIndex("response_size", sizeEdgesBytes)+` AS si, count()
		FROM api_requests WHERE `+where+` GROUP BY ri, si`, args...)
	if err != nil {
		return nil, internalError("endpoint size histogram", err)
	}
	defer func() { _ = hrows.Close() }()
	reqCounts := make([]uint64, len(sizeEdgesBytes)+1)
	respCounts := make([]uint64, len(sizeEdgesBytes)+1)
	for hrows.Next() {
		var ri, si, n uint64
		if err := hrows.Scan(&ri, &si, &n); err != nil {
			return nil, internalError("endpoint size histogram", err)
		}
		reqCounts[ri] += n
		respCounts[si] += n
	}
	if err := hrows.Err(); err != nil {
		return nil, internalError("endpoint size histogram", err)
	}
	b.RequestSizeHistogram, b.ResponseSizeHistogram = sizeBuckets(reqCounts), sizeBuckets(respCounts)
	return out, nil
}

func sizeBuckets(counts []uint64) []sizeBucket {
	out := make([]sizeBucket, len(counts))
	for i, n := range counts {
		bk := sizeBucket{Count: n}
		if i > 0 {
			bk.FromBytes = sizeEdgesBytes[i-1]
		}
		if i < len(sizeEdgesBytes) {
			bk.ToBytes = &sizeEdgesBytes[i]
		}
		out[i] = bk
	}
	return out
}
