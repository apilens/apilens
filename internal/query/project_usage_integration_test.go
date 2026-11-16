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

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestProjectUsage seeds the edge's per-app counters in a real Valkey and
// reads GET /api/v1/projects/{project}/usage: per-day records and bytes,
// rejections by reason, totals per app and environment, the quota reading,
// equality with the sum of every app's ingest-stats, tenant isolation and
// the 503 without counters.
func TestProjectUsage(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	stats := ingest.NewValkeyStats(vk)

	shop, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	billing, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "billing", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	bank, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	if billing.ProjectID != shop.ProjectID || billing.AppID == shop.AppID {
		t.Fatalf("billing = %+v, want a second app of shop", billing)
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	yesterday := today.AddDate(0, 0, -1)
	add := func(day time.Time, project uuid.UUID, bytes int64, counts map[uuid.UUID]ingest.Counts, b map[uuid.UUID]ingest.Breakdown) {
		t.Helper()
		if err := stats.Add(ctx, day, counts); err != nil {
			t.Fatal(err)
		}
		if err := stats.AddUsage(ctx, day, project, bytes, b); err != nil {
			t.Fatal(err)
		}
	}
	add(today, shop.ProjectID, 1500, map[uuid.UUID]ingest.Counts{
		shop.AppID:    {Accepted: 100, Rejected: 7, Truncated: 2, Masked: 3},
		billing.AppID: {Accepted: 20, Rejected: 1},
	}, map[uuid.UUID]ingest.Breakdown{
		shop.AppID: {
			RejectedBy:   map[string]int64{ingest.ReasonRecordsPerMinute: 5, ingest.ReasonInvalid: 2},
			Environments: map[string]int64{"production": 90, "staging": 10},
		},
		billing.AppID: {
			RejectedBy:   map[string]int64{ingest.ReasonBytesPerDay: 1},
			Environments: map[string]int64{"production": 20},
		},
	})
	// Yesterday's counters predate the breakdowns: no reasons, no
	// environments.
	add(yesterday, shop.ProjectID, 500, map[uuid.UUID]ingest.Counts{shop.AppID: {Accepted: 40, Rejected: 4}}, nil)
	add(today, bank.ProjectID, 1<<20, map[uuid.UUID]ingest.Counts{bank.AppID: {Accepted: 9999}},
		map[uuid.UUID]ingest.Breakdown{bank.AppID: {Environments: map[string]int64{"production": 9999}}})

	newServer := func(withStats bool) *httptest.Server {
		srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
		api := srv.API()
		authn.AddSecurityScheme(api)
		api.UseMiddleware(func(hc huma.Context, next func(huma.Context)) {
			if id, err := uuid.Parse(hc.Header(testUserHeader)); err == nil {
				hc = huma.WithContext(hc, authn.WithPrincipal(hc.Context(), authn.Principal{Kind: authn.KindUser, UserID: id, SessionID: uuid.New(), AMR: []string{"otp"}}))
			}
			next(hc)
		})
		q := db.New(pool)
		verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
		guard := authz.NewGuard(projectChecker{shop.ProjectID.String(): true}, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
		api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
		svc := query.NewService(nil, q).WithQuota(config.QuotaConfig{RecordsPerMinute: 6000, BytesPerDay: 3000})
		if withStats {
			svc.WithIngestStats(stats)
		}
		query.Register(api, svc, guard)
		ts := httptest.NewServer(srv.Handler())
		t.Cleanup(ts.Close)
		return ts
	}
	ts := newServer(true)
	user := uuid.NewString()
	get := func(ts *httptest.Server, header, value, path string, out any) int {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		req.Header.Set(header, value)
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

	var u query.ProjectUsage
	if code := get(ts, testUserHeader, user, "/api/v1/projects/shop/usage?days=7", &u); code != http.StatusOK {
		t.Fatalf("usage = %d", code)
	}
	if u.Project != "shop" || u.Days != 7 || len(u.Daily) != 7 {
		t.Fatalf("usage = %+v", u)
	}
	wantTotals := query.IngestCounts{Accepted: 160, Rejected: 12, Truncated: 2, Masked: 3}
	if u.Totals.IngestCounts != wantTotals || u.Bytes != 2000 {
		t.Errorf("totals = %+v bytes %d, want %+v and 2000", u.Totals, u.Bytes, wantTotals)
	}
	reasons := func(r []query.RejectedRecords) map[string]int64 {
		m := map[string]int64{}
		for _, x := range r {
			m[x.Reason] = x.Records
		}
		return m
	}
	if got := reasons(u.Totals.RejectedByReason); len(got) != 4 || got["records_per_minute"] != 5 || got["invalid"] != 2 ||
		got["bytes_per_day"] != 1 || got[query.ReasonUnspecified] != 4 {
		t.Errorf("rejected by reason = %+v", u.Totals.RejectedByReason)
	}
	d6, d5 := u.Daily[6], u.Daily[5]
	if d6.Date != today.Format(time.DateOnly) || d6.Accepted != 120 || d6.Rejected != 8 || d6.Bytes != 1500 ||
		d5.Date != yesterday.Format(time.DateOnly) || d5.Accepted != 40 || d5.Bytes != 500 || u.Daily[0].Accepted != 0 {
		t.Errorf("daily = %+v", u.Daily)
	}
	if len(u.Apps) != 2 || u.Apps[0].App != "storefront" || u.Apps[0].Accepted != 140 || u.Apps[0].Rejected != 11 ||
		u.Apps[1].App != "billing" || u.Apps[1].Accepted != 20 {
		t.Errorf("apps = %+v", u.Apps)
	}
	if len(u.Environments) != 2 || u.Environments[0] != (query.EnvironmentUsage{Environment: "production", Accepted: 110}) ||
		u.Environments[1] != (query.EnvironmentUsage{Environment: "staging", Accepted: 10}) {
		t.Errorf("environments = %+v", u.Environments)
	}
	if q := u.Quota; q.RecordsPerMinute != 6000 || q.BytesPerDay != 3000 || q.BytesToday != 1500 || q.RejectedToday != 6 ||
		q.BytesTodayRatio == nil || *q.BytesTodayRatio != 0.5 {
		t.Errorf("quota = %+v", q)
	}

	// The project totals equal the sum of every app's ingest-stats for the
	// same days.
	var sum query.IngestCounts
	for _, app := range []uuid.UUID{shop.AppID, billing.AppID} {
		var s query.AppIngestStats
		if code := get(ts, "Authorization", "Bearer "+shop.ReadKey, "/api/v1/apps/"+app.String()+"/ingest-stats?days=7", &s); code != http.StatusOK {
			t.Fatalf("ingest-stats %s = %d", app, code)
		}
		sum.Accepted += s.Totals.Accepted
		sum.Rejected += s.Totals.Rejected
		sum.Truncated += s.Totals.Truncated
		sum.Masked += s.Totals.Masked
	}
	if sum != u.Totals.IngestCounts {
		t.Errorf("sum of app ingest-stats = %+v, project usage = %+v", sum, u.Totals.IngestCounts)
	}

	// Default window is 30 days.
	if code := get(ts, testUserHeader, user, "/api/v1/projects/shop/usage", &u); code != http.StatusOK || u.Days != 30 || len(u.Daily) != 30 {
		t.Errorf("default = %d days %d", code, u.Days)
	}
	for _, tc := range []struct {
		name string
		ts   *httptest.Server
		path string
		want int
	}{
		{"no view on the other tenant", ts, "/api/v1/projects/bank/usage", http.StatusNotFound},
		{"unknown project", ts, "/api/v1/projects/nope/usage", http.StatusNotFound},
		{"days out of range", ts, "/api/v1/projects/shop/usage?days=31", http.StatusUnprocessableEntity},
		{"no counters", newServer(false), "/api/v1/projects/shop/usage", http.StatusServiceUnavailable},
	} {
		if code := get(tc.ts, testUserHeader, user, tc.path, nil); code != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, code, tc.want)
		}
	}
}
