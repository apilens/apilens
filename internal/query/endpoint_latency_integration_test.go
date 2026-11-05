//go:build integration

package query_test

import (
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/pipeline"
)

type endpointLatency struct {
	Method        string `json:"method"`
	Path          string `json:"path"`
	BucketSeconds int    `json:"bucket_seconds"`
	Summary       struct {
		Requests uint64  `json:"requests"`
		AvgMs    float64 `json:"avg_ms"`
		MaxMs    float64 `json:"max_ms"`
		P50Ms    float64 `json:"p50_ms"`
		P75Ms    float64 `json:"p75_ms"`
		P90Ms    float64 `json:"p90_ms"`
		P95Ms    float64 `json:"p95_ms"`
		P99Ms    float64 `json:"p99_ms"`
	} `json:"summary"`
	Points []struct {
		TS       time.Time `json:"ts"`
		Requests uint64    `json:"requests"`
		P50Ms    float64   `json:"p50_ms"`
		P75Ms    float64   `json:"p75_ms"`
		P95Ms    float64   `json:"p95_ms"`
	} `json:"points"`
	Histogram []struct {
		FromMs float64  `json:"from_ms"`
		ToMs   *float64 `json:"to_ms"`
		Count  uint64   `json:"count"`
	} `json:"histogram"`
}

type sizeBucket struct {
	FromBytes uint64  `json:"from_bytes"`
	ToBytes   *uint64 `json:"to_bytes"`
	Count     uint64  `json:"count"`
}

type endpointTransfer struct {
	BucketSeconds int `json:"bucket_seconds"`
	Summary       struct {
		Requests         uint64  `json:"requests"`
		RequestBytes     uint64  `json:"request_bytes"`
		ResponseBytes    uint64  `json:"response_bytes"`
		AvgRequestBytes  float64 `json:"avg_request_bytes"`
		AvgResponseBytes float64 `json:"avg_response_bytes"`
	} `json:"summary"`
	Points []struct {
		TS            time.Time `json:"ts"`
		Requests      uint64    `json:"requests"`
		RequestBytes  uint64    `json:"request_bytes"`
		ResponseBytes uint64    `json:"response_bytes"`
	} `json:"points"`
	RequestSizeHistogram  []sizeBucket `json:"request_size_histogram"`
	ResponseSizeHistogram []sizeBucket `json:"response_size_histogram"`
}

func endpointTabURL(tab, method, path, query string) string {
	return "/api/v1/endpoints/" + method + "/" + url.PathEscape(path) + "/" + tab + "?" + query
}

func latencyCounts(out endpointLatency) []uint64 {
	c := make([]uint64, 0, len(out.Histogram))
	for _, b := range out.Histogram {
		c = append(c, b.Count)
	}
	return c
}

func sizeCounts(h []sizeBucket) []uint64 {
	c := make([]uint64, 0, len(h))
	for _, b := range h {
		c = append(c, b.Count)
	}
	return c
}

func seedEndpointPerformance(t *testing.T) (get func(key, path string, out any) int, mine, theirs bootstrap.Result) {
	t.Helper()
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC()
	i := 0
	row := func(p bootstrap.Result, env, method string, code uint16, ms float64, in, out uint64, consumer string) pipeline.RequestRow {
		i++
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: env, Timestamp: now.Add(-time.Duration(i) * time.Minute),
			Method: method, Path: "/orders/{id}", RawPath: "/orders/1", StatusCode: code, ResponseTimeMs: ms,
			RequestSize: in, ResponseSize: out, ConsumerID: consumer,
		}
	}
	rows := []pipeline.RequestRow{
		row(mine, "production", "GET", 200, 0.5, 0, 0, "alice"),
		row(mine, "production", "GET", 200, 1.5, 0, 300, "alice"),
		row(mine, "production", "GET", 404, 7, 100, 1024, "bob"),
		row(mine, "production", "GET", 200, 150, 2000, 70000, "bob"),
		row(mine, "production", "GET", 500, 12000, 5<<20, 5<<20, "alice"),
		row(mine, "staging", "GET", 200, 30, 300, 10, "carol"),
		row(mine, "production", "POST", 200, 3, 50, 50, "alice"),
		row(theirs, "production", "GET", 200, 999, 9999, 9999, "mallory"),
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}
	return get, mine, theirs
}

func TestEndpointLatency(t *testing.T) {
	get, mine, theirs := seedEndpointPerformance(t)
	const tmpl = "/orders/{id}"
	fetch := func(key, query string) endpointLatency {
		t.Helper()
		var out endpointLatency
		if code := get(key, endpointTabURL("latency", "GET", tmpl, query), &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", query, code)
		}
		if len(out.Histogram) != 14 || out.Histogram[0].FromMs != 0 || out.Histogram[13].ToMs != nil ||
			out.Histogram[13].FromMs != 10000 || *out.Histogram[3].ToMs != 10 {
			t.Fatalf("%s: histogram edges %+v", query, out.Histogram)
		}
		var n uint64
		for _, p := range out.Points {
			n += p.Requests
		}
		if n != out.Summary.Requests {
			t.Fatalf("%s: points add up to %d, want %d", query, n, out.Summary.Requests)
		}
		return out
	}

	// Rollup path, all environments.
	out := fetch(mine.ReadKey, "range=1h")
	s := out.Summary
	if out.Method != http.MethodGet || out.Path != tmpl || out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("all: method=%q path=%q bucket=%d points=%d", out.Method, out.Path, out.BucketSeconds, len(out.Points))
	}
	if s.Requests != 6 || s.MaxMs != 12000 || s.AvgMs != 2031.5 {
		t.Fatalf("all: summary %+v", s)
	}
	if !(s.P50Ms > 0 && s.P50Ms <= s.P75Ms && s.P75Ms <= s.P90Ms && s.P90Ms <= s.P95Ms && s.P95Ms <= s.P99Ms && s.P99Ms <= 12000) {
		t.Fatalf("all: percentiles not ordered %+v", s)
	}
	//                          <1 <2 <5 <10 <20 <50 <100 <200 <500 <1s <2s <5s <10s +inf
	want := []uint64{1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1}
	if got := latencyCounts(out); !slices.Equal(got, want) {
		t.Fatalf("all: histogram %v, want %v", got, want)
	}
	for _, p := range out.Points {
		if p.Requests == 1 && (p.P50Ms != p.P95Ms || p.P50Ms == 0) {
			t.Fatalf("all: single-request bucket %+v", p)
		}
	}

	// Environment filter (rollup) and 7d (hourly rollup).
	if s := fetch(mine.ReadKey, "range=1h&env=staging").Summary; s.Requests != 1 || s.P50Ms != 30 || s.MaxMs != 30 {
		t.Fatalf("staging: %+v", s)
	}
	if out := fetch(mine.ReadKey, "range=7d"); out.Summary.Requests != 6 || out.BucketSeconds != 3600 {
		t.Fatalf("7d: %+v", out.Summary)
	}
	// Status and consumer filters read raw rows.
	out = fetch(mine.ReadKey, "range=6h&status=5xx")
	if out.Summary.Requests != 1 || out.Summary.P95Ms != 12000 || !slices.Equal(latencyCounts(out), []uint64{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}) {
		t.Fatalf("5xx: %+v %v", out.Summary, latencyCounts(out))
	}
	out = fetch(mine.ReadKey, "range=24h&consumer=bob")
	if out.Summary.Requests != 2 || out.Summary.MaxMs != 150 || out.Summary.AvgMs != 78.5 {
		t.Fatalf("bob: %+v", out.Summary)
	}
	// An unknown endpoint is empty, not 404.
	var empty endpointLatency
	if code := get(mine.ReadKey, endpointTabURL("latency", "GET", "/nope", "range=1h"), &empty); code != http.StatusOK ||
		empty.Summary.Requests != 0 || empty.Summary.P95Ms != 0 || len(empty.Histogram) != 14 {
		t.Fatalf("unknown: %d %+v", code, empty)
	}
	// The other project sees only its own row.
	if s := fetch(theirs.ReadKey, "range=1h").Summary; s.Requests != 1 || s.MaxMs != 999 {
		t.Fatalf("other project: %+v", s)
	}
	for _, bad := range []string{
		endpointTabURL("latency", "G3T", tmpl, "range=1h"),
		endpointTabURL("latency", "GET", tmpl, "range=30d"),
		endpointTabURL("latency", "GET", tmpl, "status=6xx"),
	} {
		if code := get(mine.ReadKey, bad, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d, want 422", bad, code)
		}
	}
	if code := get(mine.APIKey, endpointTabURL("latency", "GET", tmpl, "range=1h"), nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}

func TestEndpointTransfer(t *testing.T) {
	get, mine, theirs := seedEndpointPerformance(t)
	const tmpl = "/orders/{id}"
	fetch := func(key, query string) endpointTransfer {
		t.Helper()
		var out endpointTransfer
		if code := get(key, endpointTabURL("transfer", "GET", tmpl, query), &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", query, code)
		}
		for _, h := range [][]sizeBucket{out.RequestSizeHistogram, out.ResponseSizeHistogram} {
			if len(h) != 10 || h[0].FromBytes != 0 || *h[0].ToBytes != 1 || h[9].ToBytes != nil || h[9].FromBytes != 4<<20 {
				t.Fatalf("%s: histogram edges %+v", query, h)
			}
		}
		var n, in, outB uint64
		for _, p := range out.Points {
			n, in, outB = n+p.Requests, in+p.RequestBytes, outB+p.ResponseBytes
		}
		if n != out.Summary.Requests || in != out.Summary.RequestBytes || outB != out.Summary.ResponseBytes {
			t.Fatalf("%s: points add up to %d/%d/%d, summary %+v", query, n, in, outB, out.Summary)
		}
		return out
	}

	out := fetch(mine.ReadKey, "range=1h")
	s := out.Summary
	if out.BucketSeconds != 60 || len(out.Points) != 60 {
		t.Fatalf("all: bucket=%d points=%d", out.BucketSeconds, len(out.Points))
	}
	if s.Requests != 6 || s.RequestBytes != 5245280 || s.ResponseBytes != 5314214 ||
		s.AvgRequestBytes != 874213.33 || s.AvgResponseBytes != 885702.33 {
		t.Fatalf("all: summary %+v", s)
	}
	//                        0  <256 <1K <4K <16K <64K <256K <1M <4M +inf
	if got, want := sizeCounts(out.RequestSizeHistogram), []uint64{2, 1, 1, 1, 0, 0, 0, 0, 0, 1}; !slices.Equal(got, want) {
		t.Fatalf("request sizes %v, want %v", got, want)
	}
	if got, want := sizeCounts(out.ResponseSizeHistogram), []uint64{1, 1, 1, 1, 0, 0, 1, 0, 0, 1}; !slices.Equal(got, want) {
		t.Fatalf("response sizes %v, want %v", got, want)
	}

	if s := fetch(mine.ReadKey, "range=1h&env=staging").Summary; s.Requests != 1 || s.RequestBytes != 300 || s.ResponseBytes != 10 {
		t.Fatalf("staging: %+v", s)
	}
	if out := fetch(mine.ReadKey, "range=7d"); out.Summary.RequestBytes != 5245280 || out.BucketSeconds != 3600 {
		t.Fatalf("7d: %+v", out.Summary)
	}
	out = fetch(mine.ReadKey, "range=6h&consumer=bob&status=4xx")
	if s := out.Summary; s.Requests != 1 || s.RequestBytes != 100 || s.ResponseBytes != 1024 || s.AvgResponseBytes != 1024 {
		t.Fatalf("bob 4xx: %+v", s)
	}
	if got := sizeCounts(out.ResponseSizeHistogram); !slices.Equal(got, []uint64{0, 0, 0, 1, 0, 0, 0, 0, 0, 0}) {
		t.Fatalf("bob 4xx response sizes %v", got)
	}
	if s := fetch(theirs.ReadKey, "range=1h").Summary; s.Requests != 1 || s.RequestBytes != 9999 {
		t.Fatalf("other project: %+v", s)
	}
	if code := get(mine.ReadKey, endpointTabURL("transfer", "GET", tmpl, "range=30d"), nil); code != http.StatusUnprocessableEntity {
		t.Fatalf("bad range = %d, want 422", code)
	}
	if code := get(mine.APIKey, endpointTabURL("transfer", "GET", tmpl, "range=1h"), nil); code != http.StatusForbidden {
		t.Fatalf("ingest key = %d, want 403", code)
	}
}
