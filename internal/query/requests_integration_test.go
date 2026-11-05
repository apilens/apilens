//go:build integration

package query_test

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

type requestLog struct {
	Requests []struct {
		Timestamp     time.Time `json:"timestamp"`
		RawPath       string    `json:"raw_path"`
		StatusCode    int       `json:"status_code"`
		ConsumerGroup string    `json:"consumer_group"`
		IPAddress     string    `json:"ip_address"`
		RequestSize   uint64    `json:"request_size"`
		ResponseSize  uint64    `json:"response_size"`
		Sampled       bool      `json:"sampled"`
		TraceID       string    `json:"trace_id"`
	} `json:"requests"`
	NextCursor string `json:"next_cursor"`
}

func (l requestLog) paths() []string {
	out := []string{}
	for _, r := range l.Requests {
		out = append(out, r.RawPath)
	}
	return out
}

// TestRequestLogFilters checks every filter of /api/v1/requests on a small
// fixture where each row is identified by its raw path.
func TestRequestLogFilters(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC()
	type fx struct {
		raw, method, path   string
		code                uint16
		ms                  float64
		reqSize, respSize   uint64
		ip, consumer, group string
		reqBody, respBody   string
		sampled             bool
		trace               string
	}
	fixture := []fx{
		{"/orders/1?expand=items", "GET", "/orders/{id}", 200, 12, 0, 300, "10.0.0.1", "alice", "free", "", `{"id":1,"sku":"RED-Shoe"}`, true, "aaaa0000000000000000000000000001"},
		{"/orders/2", "GET", "/orders/{id}", 404, 8, 0, 40, "10.0.0.2", "bob", "pro", "", `{"error":"not found"}`, true, "aaaa0000000000000000000000000002"},
		{"/orders", "POST", "/orders", 201, 120, 2048, 512, "10.0.0.1", "alice", "free", `{"note":"50%_off"}`, `{"id":3}`, true, "aaaa0000000000000000000000000003"},
		{"/orders", "POST", "/orders", 422, 30, 64, 128, "10.0.0.3", "carol", "pro", `{"qty":-1}`, `{"detail":"bad qty"}`, true, "aaaa0000000000000000000000000004"},
		{"/payments/9", "PUT", "/payments/{id}", 500, 900, 256, 0, "10.0.0.2", "bob", "pro", "", "", false, "aaaa0000000000000000000000000005"},
		{"/payments/10", "PUT", "/payments/{id}", 503, 2500, 256, 64, "10.0.0.4", "", "", "", "", true, "aaaa0000000000000000000000000006"},
	}
	var rows []pipeline.RequestRow
	for i, f := range fixture {
		rows = append(rows, pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Duration(i+1) * time.Minute),
			Method: f.method, Path: f.path, RawPath: f.raw, StatusCode: f.code, ResponseTimeMs: f.ms,
			RequestSize: f.reqSize, ResponseSize: f.respSize, IPAddress: f.ip, ConsumerID: f.consumer, ConsumerGroup: f.group,
			RequestPayload: f.reqBody, ResponsePayload: f.respBody, Sampled: f.sampled, TraceID: f.trace,
		})
	}
	// Another project's rows match every filter below; none may show.
	for _, r := range slices.Clone(rows) {
		r.ProjectID, r.AppID = theirs.ProjectID, theirs.AppID
		rows = append(rows, r)
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name, query string
		want        []string
	}{
		{"none", "", []string{"/orders/1?expand=items", "/orders/2", "/orders", "/orders", "/payments/9", "/payments/10"}},
		{"consumer_id", "consumer_id=alice", []string{"/orders/1?expand=items", "/orders"}},
		{"consumer_group", "consumer_group=pro", []string{"/orders/2", "/orders", "/payments/9"}},
		{"ip", "ip=10.0.0.2", []string{"/orders/2", "/payments/9"}},
		{"method", "method=put", []string{"/payments/9", "/payments/10"}},
		{"path", "path=" + url.QueryEscape("/orders/{id}"), []string{"/orders/1?expand=items", "/orders/2"}},
		{"url_contains", "url_contains=EXPAND", []string{"/orders/1?expand=items"}},
		{"url_contains escapes LIKE", "url_contains=" + url.QueryEscape("orders_"), []string{}},
		{"payload_contains request", "payload_contains=" + url.QueryEscape("50%_OFF"), []string{"/orders"}},
		{"payload_contains response", "payload_contains=red-shoe", []string{"/orders/1?expand=items"}},
		{"request_size_min", "request_size_min=256", []string{"/orders", "/payments/9", "/payments/10"}},
		{"request_size_max", "request_size_max=64", []string{"/orders/1?expand=items", "/orders/2", "/orders"}},
		{"request_size_max zero", "request_size_max=0", []string{"/orders/1?expand=items", "/orders/2"}},
		{"response_size_min", "response_size_min=300", []string{"/orders/1?expand=items", "/orders"}},
		{"response_size_max", "response_size_max=64", []string{"/orders/2", "/payments/9", "/payments/10"}},
		{"status class", "status=5xx", []string{"/payments/9", "/payments/10"}},
		{"status list", "status=" + url.QueryEscape("201,404"), []string{"/orders/2", "/orders"}},
		{"status range", "status=" + url.QueryEscape("420-500"), []string{"/orders", "/payments/9"}},
		{"status all", "status=all", []string{"/orders/1?expand=items", "/orders/2", "/orders", "/orders", "/payments/9", "/payments/10"}},
		{"latency_min", "latency_min=900", []string{"/payments/9", "/payments/10"}},
		{"latency_max", "latency_max=30", []string{"/orders/1?expand=items", "/orders/2", "/orders"}},
		{"sampled false", "sampled=false", []string{"/payments/9"}},
		{"sampled true", "sampled=true&method=PUT", []string{"/payments/10"}},
		{"trace_id", "trace_id=aaaa0000000000000000000000000004", []string{"/orders"}},
		{"combined", "consumer_group=pro&status=4xx&latency_max=10", []string{"/orders/2"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			var out requestLog
			if code := get(mine.ReadKey, "/api/v1/requests?range=1h&"+c.query, &out); code != http.StatusOK {
				t.Fatalf("status %d", code)
			}
			if got := out.paths(); !slices.Equal(got, c.want) {
				t.Fatalf("got %q, want %q", got, c.want)
			}
			if out.NextCursor != "" {
				t.Fatalf("next_cursor %q on a single page", out.NextCursor)
			}
		})
	}

	// The response carries the new columns.
	var one requestLog
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h&trace_id=aaaa0000000000000000000000000003", &one); code != http.StatusOK || len(one.Requests) != 1 {
		t.Fatalf("one = %d %+v", code, one)
	}
	if r := one.Requests[0]; r.ConsumerGroup != "free" || r.IPAddress != "10.0.0.1" || r.RequestSize != 2048 || r.ResponseSize != 512 || !r.Sampled {
		t.Fatalf("row = %+v", r)
	}

	for _, bad := range []string{"status=6xx", "status=" + url.QueryEscape("503-500"), "cursor=" + url.QueryEscape("%%"), "limit=201", "sampled=maybe", "method=" + url.QueryEscape("G T")} {
		if code := get(mine.ReadKey, "/api/v1/requests?range=1h&"+bad, nil); code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d, want 422", bad, code)
		}
	}
}

// TestRequestLogCursorPagination walks the log page by page, including rows
// that share a timestamp, and checks every row is seen exactly once in order.
func TestRequestLogCursorPagination(t *testing.T) {
	ctx, conn, mine, _, get := endpointRequestsEnv(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	var rows []pipeline.RequestRow
	for i := range 25 {
		// Pairs of rows share a timestamp; trace ids break the tie.
		rows = append(rows, pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production",
			Timestamp: now.Add(-time.Duration(i/2+1) * time.Second), Method: "GET", Path: "/p", RawPath: fmt.Sprintf("/p/%02d", i),
			StatusCode: 200, Sampled: true, TraceID: fmt.Sprintf("%032x", i),
		})
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}
	var (
		seen   []string
		cursor string
		pages  int
	)
	for {
		var out requestLog
		q := "/api/v1/requests?range=1h&limit=7"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		if code := get(mine.ReadKey, q, &out); code != http.StatusOK {
			t.Fatalf("page %d: status %d", pages, code)
		}
		pages++
		for i, r := range out.Requests {
			if i > 0 {
				prev := out.Requests[i-1]
				if r.Timestamp.After(prev.Timestamp) || (r.Timestamp.Equal(prev.Timestamp) && r.TraceID > prev.TraceID) {
					t.Fatalf("page %d out of order at %d", pages, i)
				}
			}
			seen = append(seen, r.TraceID)
		}
		if out.NextCursor == "" {
			if len(out.Requests) != 4 {
				t.Fatalf("last page has %d rows, want 4", len(out.Requests))
			}
			break
		}
		if len(out.Requests) != 7 {
			t.Fatalf("page %d has %d rows, want 7", pages, len(out.Requests))
		}
		cursor = out.NextCursor
		if pages > 10 {
			t.Fatal("pagination does not end")
		}
	}
	if pages != 4 || len(seen) != 25 {
		t.Fatalf("pages=%d rows=%d, want 4 pages and 25 rows", pages, len(seen))
	}
	sorted := slices.Clone(seen)
	slices.Sort(sorted)
	if len(slices.Compact(sorted)) != 25 {
		t.Fatalf("duplicate rows across pages: %v", seen)
	}

	// A page of exactly the remaining rows has no next cursor.
	var all requestLog
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h&limit=25", &all); code != http.StatusOK || len(all.Requests) != 25 || all.NextCursor != "" {
		t.Fatalf("full page = %d rows=%d cursor=%q", code, len(all.Requests), all.NextCursor)
	}
}

// TestRequestLogPayloadBenchmark times payload_contains, the one filter no
// sort key or index narrows, against the 2 s budget of issue #576 on 10M
// rows with bodies. It is slow, so it only runs with APILENS_BENCH=1.
func TestRequestLogPayloadBenchmark(t *testing.T) {
	if os.Getenv("APILENS_BENCH") == "" {
		t.Skip("set APILENS_BENCH=1 to run the 10M-row benchmark")
	}
	ctx, conn, mine, _, get := endpointRequestsEnv(t)
	const total, chunk = 10_000_000, 1_000_000
	start := time.Now()
	// JSON-like bodies without braces: the driver reads {name:Type} as a
	// server-side parameter.
	for off := 0; off < total; off += chunk {
		if err := conn.Exec(ctx, `
			INSERT INTO api_requests (project_id, app_id, environment, timestamp, method, path, raw_path,
			                          status_code, response_time_ms, consumer_id, request_payload, response_payload)
			SELECT ?, ?, 'production', now64(3) - toIntervalMillisecond(number % 86400000),
			       'POST', concat('/r', toString(number % 40), '/{id}'), concat('/r', toString(number % 40), '/', toString(number)),
			       200, (number % 1000) / 3.0, concat('c', toString(number % 5000)),
			       concat('"order_id": ', toString(number), ', "sku": "SKU-', toString(number % 100000), '", "qty": ', toString(number % 7)),
			       concat('"id": "', toString(cityHash64(number)), '", "status": "accepted", "total": ', toString(number % 10000))
			FROM numbers(?, ?)`, mine.ProjectID, mine.AppID, off, chunk); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("seeded %d rows in %v", total, time.Since(start))

	// Every call searches for new text: ClickHouse's query condition cache
	// would otherwise skip the granules a repeated predicate already ruled out.
	for _, c := range []struct{ name, query string }{
		{"payload hit", "payload_contains=SKU-%d%%22"},
		{"payload miss", "payload_contains=no-such-text-%d"},
		{"url", "url_contains=%%2F%d42"},
	} {
		var took []time.Duration
		for i := range 10 {
			var out requestLog
			t0 := time.Now()
			if code := get(mine.ReadKey, "/api/v1/requests?range=24h&limit=200&"+fmt.Sprintf(c.query, 4242+i), &out); code != http.StatusOK {
				t.Fatalf("%s: status %d", c.name, code)
			}
			took = append(took, time.Since(t0))
		}
		slices.Sort(took)
		worst := took[len(took)-1]
		t.Logf("%s: p50=%v max=%v", c.name, took[len(took)/2], worst)
		if worst > 2*time.Second {
			t.Errorf("%s: %v over the 2 s budget", c.name, worst)
		}
	}
}
