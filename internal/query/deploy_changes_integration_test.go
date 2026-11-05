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
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestDeployChangesCompareTheHourAroundEachDeploy checks GET
// /api/v1/deploys/changes: the before/after error rate and p95 of a deploy,
// scoped to its app and environment, with the deploy minute in neither side.
func TestDeployChangesCompareTheHourAroundEachDeploy(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	mine, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	deployed := now.Add(-3 * time.Hour).Truncate(time.Minute).Add(20 * time.Second)
	at := func(minutes int) time.Time {
		return deployed.Truncate(time.Minute).Add(time.Duration(minutes)*time.Minute + 5*time.Second)
	}
	row := func(project, app uuid.UUID, env string, ts time.Time, code uint16, ms float64) pipeline.RequestRow {
		return pipeline.RequestRow{ProjectID: project, AppID: app, Environment: env, Timestamp: ts, Method: "GET", Path: "/orders", RawPath: "/orders", StatusCode: code, ResponseTimeMs: ms}
	}
	var rows []pipeline.RequestRow
	// Before: 10 requests, 1 server error, 20 ms.
	for i := range 10 {
		code := uint16(200)
		if i == 0 {
			code = 500
		}
		rows = append(rows, row(mine.ProjectID, mine.AppID, "production", at(-30+i), code, 20))
	}
	// The deploy minute itself: excluded from both sides.
	rows = append(rows, row(mine.ProjectID, mine.AppID, "production", at(0), 500, 9000))
	// After: 4 requests, 2 errors, 200 ms.
	for i, code := range []uint16{200, 503, 404, 200} {
		rows = append(rows, row(mine.ProjectID, mine.AppID, "production", at(5+i), code, 200))
	}
	// Outside both windows, another environment, another app and another project: all ignored.
	rows = append(rows,
		row(mine.ProjectID, mine.AppID, "production", at(-90), 500, 5000),
		row(mine.ProjectID, mine.AppID, "production", at(90), 500, 5000),
		row(mine.ProjectID, mine.AppID, "staging", at(10), 500, 5000),
		row(mine.ProjectID, uuid.New(), "production", at(10), 500, 5000),
		row(theirs.ProjectID, theirs.AppID, "production", at(10), 500, 5000),
	)
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}
	if err := ins.Deploys(ctx, []pipeline.DeployRow{
		{ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Release: "v2.4.0", Commit: "abc123", DeployedAt: deployed},
		{ProjectID: mine.ProjectID, Environment: "production", Release: "v2.5.0", DeployedAt: now.Add(-10 * time.Minute)},
		{ProjectID: theirs.ProjectID, Environment: "production", Release: "secret", DeployedAt: deployed},
	}); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/deploys/changes?range=6h", nil)
	req.Header.Set("Authorization", "Bearer "+mine.ReadKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	type side struct {
		Requests  uint64  `json:"requests"`
		ErrorRate float64 `json:"error_rate"`
		P95Ms     float64 `json:"p95_ms"`
	}
	var out struct {
		WindowMinutes int `json:"window_minutes"`
		Deploys       []struct {
			Release      string `json:"release"`
			AppID        string `json:"app_id"`
			Before       side   `json:"before"`
			After        side   `json:"after"`
			AfterPartial bool   `json:"after_partial"`
		} `json:"deploys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.WindowMinutes != 60 || len(out.Deploys) != 2 {
		t.Fatalf("changes = %+v", out)
	}
	recent, old := out.Deploys[0], out.Deploys[1]
	if recent.Release != "v2.5.0" || !recent.AfterPartial || recent.AppID != "" {
		t.Errorf("recent deploy = %+v", recent)
	}
	if old.Release != "v2.4.0" || old.AfterPartial || old.AppID != mine.AppID.String() {
		t.Errorf("old deploy = %+v", old)
	}
	if old.Before.Requests != 10 || old.Before.ErrorRate != 0.1 || old.Before.P95Ms < 19 || old.Before.P95Ms > 21 {
		t.Errorf("before = %+v", old.Before)
	}
	if old.After.Requests != 4 || old.After.ErrorRate != 0.5 || old.After.P95Ms < 199 || old.After.P95Ms > 201 {
		t.Errorf("after = %+v", old.After)
	}
}
