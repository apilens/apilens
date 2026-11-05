//go:build integration

package query_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
	"github.com/apilens/apilens/internal/testutil/seed"
)

// TestAppStatusAndIngestStats runs GET /api/v1/apps/{id}/status and
// /api/v1/apps/{id}/ingest-stats against real Postgres (heartbeats) and
// Valkey (edge counters): reporting state per environment and instance, SDK
// versions, summed SDK drops, today's ingest counters, and tenant scoping.
func TestAppStatusAndIngestStats(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	stats := ingest.NewValkeyStats(vk)
	q := db.New(pool)
	tenants := seed.TwoTenants(t, ctx, pool)
	mine, theirs := tenants.Mine, tenants.Theirs

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(nil, q).WithIngestStats(stats), nil)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	get := func(key, path string, out any) int {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	statusPath := func(app uuid.UUID) string { return "/api/v1/apps/" + app.String() + "/status" }
	statsPath := func(app uuid.UUID, query string) string {
		return "/api/v1/apps/" + app.String() + "/ingest-stats" + query
	}

	// Before any heartbeat the app has never reported; no counters yet reads
	// as all zero for today.
	var st query.AppStatus
	if code := get(mine.ReadKey, statusPath(mine.AppID), &st); code != http.StatusOK || st.Status != query.StatusNever || st.LastSeenAt != nil || len(st.Instances) != 0 {
		t.Fatalf("before heartbeat = %d %+v", code, st)
	}
	if st.AppID != mine.AppID.String() || st.App != "storefront" || st.IngestToday == nil || *st.IngestToday != (query.IngestCounts{}) {
		t.Fatalf("empty app = %+v", st)
	}

	now := time.Now().UTC()
	pid := int64(7)
	seed.Heartbeat(t, ctx, q, mine, seed.Instance{
		InstanceID: "web-1", SDKName: "apilenss", SDKVersion: "0.0.1", Runtime: "python 3.13.1", Release: "r2", Commit: "abc", PID: &pid,
		Stats:  map[string]any{"queued_records": 3, "sent_records": 90, "failed_batches": 1, "dropped": 4, "drop_counts": map[string]any{"queue_full": 4}},
		SeenAt: now.Add(-30 * time.Second),
	})
	seed.Heartbeat(t, ctx, q, mine, seed.Instance{
		Environment: "staging", InstanceID: "stg-1", SDKName: "apilenss", SDKVersion: "0.0.2",
		Stats: map[string]any{"sent_records": 10, "dropped": 1, "drop_counts": map[string]any{"rejected": 1}}, SeenAt: now.Add(-30 * time.Minute),
	})
	// Silent: listed, but its counters are not summed.
	seed.Heartbeat(t, ctx, q, mine, seed.Instance{
		Environment: "staging", InstanceID: "stg-old", SDKName: "apilenss", SDKVersion: "0.0.2",
		Stats: map[string]any{"dropped": 100}, SeenAt: now.Add(-3 * time.Hour),
	})
	seed.Heartbeat(t, ctx, q, theirs, seed.Instance{InstanceID: "secret", SDKName: "apilens-js-sdk", SDKVersion: "0.0.1"})
	today := now.Truncate(24 * time.Hour)
	seed.IngestCounts(t, ctx, stats, mine.AppID, today, ingest.Counts{Accepted: 120, Rejected: 3, Truncated: 2, Masked: 5})
	seed.IngestCounts(t, ctx, stats, mine.AppID, today.AddDate(0, 0, -1), ingest.Counts{Accepted: 80, Masked: 1})
	seed.IngestCounts(t, ctx, stats, theirs.AppID, today, ingest.Counts{Accepted: 9999})

	if code := get(mine.ReadKey, statusPath(mine.AppID), &st); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if st.Status != query.StatusReporting || st.LastSeenAt == nil || len(st.Environments) != 2 {
		t.Fatalf("status = %+v", st)
	}
	if e := st.Environments[0]; e.Environment != "production" || e.Status != query.StatusReporting || e.LiveInstances != 1 {
		t.Errorf("production = %+v", e)
	}
	if e := st.Environments[1]; e.Environment != "staging" || e.Status != query.StatusStale || e.LiveInstances != 0 {
		t.Errorf("staging = %+v", e)
	}
	if len(st.Instances) != 3 || st.Instances[0].InstanceID != "web-1" || st.Instances[1].InstanceID != "stg-1" || st.Instances[2].Status != query.StatusSilent {
		t.Fatalf("instances = %+v (newest first, other project's instance must not show)", st.Instances)
	}
	if i := st.Instances[0]; i.SDKName != "apilenss" || i.SDKVersion != "0.0.1" || !i.SDKOutdated || i.SDKLatestVersion == "" ||
		i.Runtime != "python 3.13.1" || i.Release != "r2" || i.Commit != "abc" || i.PID == nil || *i.PID != 7 {
		t.Errorf("web-1 = %+v", i)
	}
	if len(st.SDKs) != 1 || st.SDKs[0].Name != "apilenss" || len(st.SDKs[0].Versions) != 2 || st.SDKs[0].Versions[0] != "0.0.1" || st.SDKs[0].OutdatedInstances != 3 {
		t.Errorf("sdks = %+v", st.SDKs)
	}
	if s := st.SDKStats; s.Instances != 2 || s.QueuedRecords != 3 || s.SentRecords != 100 || s.FailedBatches != 1 || s.DroppedRecords != 5 ||
		s.DropCounts["queue_full"] != 4 || s.DropCounts["rejected"] != 1 {
		t.Errorf("sdk_stats = %+v", s)
	}
	if st.IngestToday == nil || *st.IngestToday != (query.IngestCounts{Accepted: 120, Rejected: 3, Truncated: 2, Masked: 5}) {
		t.Errorf("ingest_today = %+v", st.IngestToday)
	}

	var is query.AppIngestStats
	if code := get(mine.ReadKey, statsPath(mine.AppID, "?days=3"), &is); code != http.StatusOK {
		t.Fatalf("ingest-stats = %d", code)
	}
	if is.AppID != mine.AppID.String() || is.App != "storefront" || is.Days != 3 || len(is.Daily) != 3 {
		t.Fatalf("ingest-stats = %+v", is)
	}
	if is.Daily[0].Date != today.AddDate(0, 0, -2).Format(time.DateOnly) || is.Daily[0].IngestCounts != (query.IngestCounts{}) ||
		is.Daily[1].Accepted != 80 || is.Daily[2].Date != today.Format(time.DateOnly) || is.Daily[2].Accepted != 120 {
		t.Errorf("daily = %+v (oldest first, empty day zero)", is.Daily)
	}
	if is.Totals != (query.IngestCounts{Accepted: 200, Rejected: 3, Truncated: 2, Masked: 6}) {
		t.Errorf("totals = %+v", is.Totals)
	}
	if code := get(mine.ReadKey, statsPath(mine.AppID, ""), &is); code != http.StatusOK || is.Days != 7 || len(is.Daily) != 7 {
		t.Errorf("default days = %d %d/%d", code, is.Days, len(is.Daily))
	}

	// Errors and tenant scoping.
	for _, c := range []struct {
		what, key, path string
		want            int
	}{
		{"ingest key status", mine.APIKey, statusPath(mine.AppID), http.StatusForbidden},
		{"ingest key stats", mine.APIKey, statsPath(mine.AppID, ""), http.StatusForbidden},
		{"other project's app status", mine.ReadKey, statusPath(theirs.AppID), http.StatusNotFound},
		{"other project's app stats", mine.ReadKey, statsPath(theirs.AppID, ""), http.StatusNotFound},
		{"unknown app status", mine.ReadKey, statusPath(uuid.New()), http.StatusNotFound},
		{"unknown app stats", mine.ReadKey, statsPath(uuid.New(), ""), http.StatusNotFound},
		{"bad app id", mine.ReadKey, "/api/v1/apps/storefront/status", http.StatusUnprocessableEntity},
		{"too many days", mine.ReadKey, statsPath(mine.AppID, "?days=31"), http.StatusUnprocessableEntity},
		{"no key", "", statusPath(mine.AppID), http.StatusUnauthorized},
	} {
		if code := get(c.key, c.path, nil); code != c.want {
			t.Errorf("%s = %d, want %d", c.what, code, c.want)
		}
	}

	// Their own read key sees their app only.
	var other query.AppStatus
	if code := get(theirs.ReadKey, statusPath(theirs.AppID), &other); code != http.StatusOK || len(other.Instances) != 1 || other.Instances[0].InstanceID != "secret" ||
		other.IngestToday == nil || other.IngestToday.Accepted != 9999 {
		t.Errorf("their status = %d %+v", code, other)
	}
}
