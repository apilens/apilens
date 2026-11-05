//go:build integration

package query_test

import (
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

type requestTimeline struct {
	From          time.Time `json:"from"`
	To            time.Time `json:"to"`
	BucketSeconds int       `json:"bucket_seconds"`
	Buckets       []struct {
		TS           time.Time `json:"ts"`
		Requests     uint64    `json:"requests"`
		Successful   uint64    `json:"successful"`
		ClientErrors uint64    `json:"client_errors"`
		ServerErrors uint64    `json:"server_errors"`
	} `json:"buckets"`
}

// totals sums the buckets: requests, successful, 4xx, 5xx.
func (tl requestTimeline) totals() [4]uint64 {
	var out [4]uint64
	for _, b := range tl.Buckets {
		out[0] += b.Requests
		out[1] += b.Successful
		out[2] += b.ClientErrors
		out[3] += b.ServerErrors
	}
	return out
}

// TestRequestTimeline checks GET /api/v1/requests/timeline (#587) and the
// from/to window of GET /api/v1/requests: bars count what the log lists.
func TestRequestTimeline(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC()
	codes := []uint16{200, 201, 302, 404, 422, 500, 503}
	var rows []pipeline.RequestRow
	for i, code := range codes {
		rows = append(rows, pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: now.Add(-time.Duration(5+i*5) * time.Minute),
			Method: "GET", Path: "/orders/{id}", RawPath: "/orders/" + string(rune('a'+i)), StatusCode: code, ResponseTimeMs: 10,
			Sampled: true, TraceID: "bbbb000000000000000000000000000" + string(rune('0'+i)),
		})
	}
	for _, r := range slices.Clone(rows) {
		r.ProjectID, r.AppID = theirs.ProjectID, theirs.AppID
		rows = append(rows, r)
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	var all requestTimeline
	if code := get(mine.ReadKey, "/api/v1/requests/timeline?range=1h", &all); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if all.BucketSeconds != 60 || len(all.Buckets) < 60 || len(all.Buckets) > 61 {
		t.Fatalf("bucket_seconds %d, %d buckets", all.BucketSeconds, len(all.Buckets))
	}
	if got := all.totals(); got != [4]uint64{7, 3, 2, 2} {
		t.Fatalf("totals = %v", got)
	}
	for i := 1; i < len(all.Buckets); i++ {
		if !all.Buckets[i].TS.After(all.Buckets[i-1].TS) {
			t.Fatalf("buckets out of order at %d", i)
		}
	}

	var errs requestTimeline
	if code := get(mine.ReadKey, "/api/v1/requests/timeline?range=1h&status=5xx", &errs); code != http.StatusOK || errs.totals() != [4]uint64{2, 0, 0, 2} {
		t.Fatalf("status=5xx: %d %v", code, errs.totals())
	}

	// A zoom on the 12 minutes from 22 to 10 minutes ago holds the rows at 20 and 15 minutes.
	from, to := now.Add(-22*time.Minute).Format(time.RFC3339), now.Add(-10*time.Minute).Format(time.RFC3339)
	window := "from=" + url.QueryEscape(from) + "&to=" + url.QueryEscape(to)
	var zoom requestTimeline
	if code := get(mine.ReadKey, "/api/v1/requests/timeline?range=1h&"+window, &zoom); code != http.StatusOK {
		t.Fatalf("zoom status %d", code)
	}
	if zoom.BucketSeconds != 10 || zoom.totals() != [4]uint64{2, 1, 1, 0} {
		t.Fatalf("zoom: bucket %d totals %v", zoom.BucketSeconds, zoom.totals())
	}
	var log requestLog
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h&"+window, &log); code != http.StatusOK {
		t.Fatalf("log status %d", code)
	}
	if got := log.paths(); !slices.Equal(got, []string{"/orders/c", "/orders/d"}) {
		t.Fatalf("zoomed log = %q", got)
	}

	for _, bad := range []string{"from=" + url.QueryEscape(to) + "&to=" + url.QueryEscape(from), "from=yesterday", "status=6xx"} {
		if code := get(mine.ReadKey, "/api/v1/requests/timeline?range=1h&"+bad, nil); code != http.StatusUnprocessableEntity {
			t.Errorf("timeline %s: status %d, want 422", bad, code)
		}
	}
	if code := get(mine.ReadKey, "/api/v1/requests?range=1h&from="+url.QueryEscape(to)+"&to="+url.QueryEscape(from), nil); code != http.StatusUnprocessableEntity {
		t.Errorf("log with reversed window: status %d, want 422", code)
	}
}
