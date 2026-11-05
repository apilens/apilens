//go:build integration

package ingest

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/testutil"
)

// TestValkeyStats runs the per-app counters against a real Valkey: deltas
// add up per app and UTC day, a day without traffic reads as zero, the keys
// expire after the retention, and the edge writes what Prometheus counts.
func TestValkeyStats(t *testing.T) {
	ctx := context.Background()
	client, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	stats := NewValkeyStats(client)

	app, other := uuid.New(), uuid.New()
	day := time.Date(2026, 11, 5, 23, 59, 0, 0, time.UTC)
	if err := stats.Add(ctx, day, map[uuid.UUID]Counts{app: {Accepted: 3, Masked: 1}, other: {Rejected: 4}}); err != nil {
		t.Fatal(err)
	}
	if err := stats.Add(ctx, day.Add(-time.Hour), map[uuid.UUID]Counts{app: {Accepted: 2, Truncated: 5}}); err != nil {
		t.Fatal(err)
	}
	if err := stats.Add(ctx, day.Add(time.Minute), map[uuid.UUID]Counts{app: {Rejected: 7}}); err != nil {
		t.Fatal(err)
	}

	days := []time.Time{day.AddDate(0, 0, -1), day, day.AddDate(0, 0, 1)}
	got, err := stats.Days(ctx, app, days)
	if err != nil {
		t.Fatal(err)
	}
	want := []Counts{{}, {Accepted: 5, Truncated: 5, Masked: 1}, {Rejected: 7}}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("days = %+v, want %+v", got, want)
	}
	if got, err := stats.Days(ctx, other, days[1:2]); err != nil || got[0] != (Counts{Rejected: 4}) {
		t.Fatalf("other = %+v, %v", got, err)
	}

	ttl, err := client.Do(ctx, client.B().Ttl().Key(statsKey(app, day)).Build()).AsInt64()
	if err != nil {
		t.Fatal(err)
	}
	if ttl <= int64(StatsRetentionDays*24*time.Hour/time.Second) || ttl > int64(statsTTL/time.Second) {
		t.Errorf("ttl = %ds", ttl)
	}

	// Through the edge: the stored counters equal the Prometheus totals.
	e, h := newStatsEdge(t, stats, nil)
	e.now = func() time.Time { return day }
	body := jsonBody(t, "requests",
		map[string]any{"app_id": "billing", "timestamp": "2026-11-05T23:58:00Z", "method": "GET", "path": "/i", "raw_path": "/i?token=x", "status_code": 200},
		map[string]any{"app_id": "billing", "timestamp": "2026-11-05T23:58:00Z", "method": "GET", "path": "/i", "status_code": 200},
	)
	if rec := post(t, h, "/v1/requests", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", rec.Code, rec.Body)
	}
	got, err = stats.Days(ctx, billingApp, []time.Time{day})
	if err != nil {
		t.Fatal(err)
	}
	accepted := int64(sumVec(e.records, []string{"requests", "accepted"}))
	masked := int64(sumVec(e.masked, []string{"requests"}))
	if accepted != 2 || masked != 1 || got[0].Accepted != accepted || got[0].Masked != masked {
		t.Fatalf("billing = %+v, Prometheus accepted %d masked %d", got[0], accepted, masked)
	}
}
