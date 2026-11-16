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

type deployListOut struct {
	Total   int `json:"total"`
	Deploys []struct {
		ID          string `json:"id"`
		Release     string `json:"release"`
		Environment string `json:"environment"`
		AppID       string `json:"app_id"`
	} `json:"deploys"`
}

type deployRefOut struct {
	ID      string `json:"id"`
	Release string `json:"release"`
}

type deployDetailOut struct {
	Deploy struct {
		ID           string `json:"id"`
		Release      string `json:"release"`
		Commit       string `json:"commit"`
		AfterPartial bool   `json:"after_partial"`
		Before       struct {
			Requests  uint64  `json:"requests"`
			ErrorRate float64 `json:"error_rate"`
		} `json:"before"`
		After struct {
			Requests  uint64  `json:"requests"`
			ErrorRate float64 `json:"error_rate"`
		} `json:"after"`
	} `json:"deploy"`
	WindowMinutes int           `json:"window_minutes"`
	DeployMinute  time.Time     `json:"deploy_minute"`
	AfterMinutes  int           `json:"after_minutes"`
	Previous      *deployRefOut `json:"previous"`
	Next          *deployRefOut `json:"next"`
	Series        []struct {
		TS           time.Time `json:"ts"`
		Requests     uint64    `json:"requests"`
		ServerErrors uint64    `json:"server_errors"`
		ClientErrors uint64    `json:"client_errors"`
	} `json:"series"`
}

type deployComparisonOut struct {
	Endpoints []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Change string `json:"change"`
		Before struct {
			Requests     uint64 `json:"requests"`
			ServerErrors uint64 `json:"server_errors"`
		} `json:"before"`
		After struct {
			Requests     uint64 `json:"requests"`
			ClientErrors uint64 `json:"client_errors"`
			ServerErrors uint64 `json:"server_errors"`
		} `json:"after"`
	} `json:"endpoints"`
	Statuses []struct {
		StatusCode uint16 `json:"status_code"`
		Before     uint64 `json:"before"`
		After      uint64 `json:"after"`
		New        bool   `json:"new"`
	} `json:"statuses"`
	Exceptions []struct {
		ExceptionType string `json:"exception_type"`
		Before        uint64 `json:"before"`
		After         uint64 `json:"after"`
		New           bool   `json:"new"`
		Path          string `json:"path"`
	} `json:"exceptions"`
	Consumers []struct {
		ConsumerID   string `json:"consumer_id"`
		ConsumerName string `json:"consumer_name"`
		BeforeErrors uint64 `json:"before_errors"`
		AfterErrors  uint64 `json:"after_errors"`
	} `json:"consumers"`
	ConsumersAffected int `json:"consumers_affected"`
}

// TestDeployDetailShowsWhatChangedWithADeploy checks GET /api/v1/deploys/{id}
// and /comparison: the deploy and its neighbours of the same app and
// environment, the per-minute series around it, and per endpoint, status,
// exception and consumer what moved, with the deploy minute on neither side.
// It also pages and filters GET /api/v1/deploys/changes.
func TestDeployDetailShowsWhatChangedWithADeploy(t *testing.T) {
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
	req := func(path string, ts time.Time, code uint16, ms float64, consumer string) pipeline.RequestRow {
		return pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: ts, Method: "GET",
			Path: path, RawPath: path, StatusCode: code, ResponseTimeMs: ms, ConsumerID: consumer, ConsumerName: consumer + " Inc",
		}
	}
	var rows []pipeline.RequestRow
	// Before: /orders 10 requests (one 500), /legacy 3 requests; acme sends two of /orders, without errors.
	for i := range 10 {
		code, consumer := uint16(200), ""
		if i == 0 {
			code = 500
		}
		if i == 1 || i == 2 {
			consumer = "acme"
		}
		rows = append(rows, req("/orders", at(-30+i), code, 20, consumer))
	}
	for i := range 3 {
		rows = append(rows, req("/legacy", at(-20+i), 200, 10, ""))
	}
	// The deploy minute: in the series, in neither side.
	rows = append(rows, req("/orders", at(0), 502, 9000, "acme"))
	// After: /orders 4 requests (acme gets a 503 and a 404), /new 2 requests; beta has no errors.
	for i, code := range []uint16{200, 503, 404, 200} {
		consumer := ""
		if code >= 400 {
			consumer = "acme"
		}
		rows = append(rows, req("/orders", at(5+i), code, 200, consumer))
	}
	rows = append(rows, req("/new", at(12), 200, 30, "beta"), req("/new", at(13), 200, 30, ""))
	// Another environment of the same app: ignored.
	staging := req("/orders", at(10), 500, 5000, "acme")
	staging.Environment = "staging"
	rows = append(rows, staging)
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}
	exc := func(msg string, ts time.Time) pipeline.LogRow {
		return pipeline.LogRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production", Timestamp: ts, Level: "ERROR",
			Message: msg, LoggerName: "apilens.exception", EndpointMethod: "GET", EndpointPath: "/orders",
		}
	}
	if err := ins.Logs(ctx, []pipeline.LogRow{
		exc("ValueError: bad sku", at(-10)),
		exc("ValueError: bad sku", at(6)),
		exc("KeyError: 'sku'", at(6)),
		exc("KeyError: 'sku'", at(7)),
		exc("ZeroDivisionError: in the deploy minute", at(0)),
	}); err != nil {
		t.Fatal(err)
	}
	app := mine.AppID
	if err := ins.Deploys(ctx, []pipeline.DeployRow{
		{ProjectID: mine.ProjectID, AppID: app, Environment: "production", Release: "v2.3.0", DeployedAt: now.Add(-5 * time.Hour)},
		{ProjectID: mine.ProjectID, AppID: app, Environment: "production", Release: "v2.4.0", Commit: "abc123", URL: "https://ci.example/1", DeployedAt: deployed},
		{ProjectID: mine.ProjectID, AppID: app, Environment: "staging", Release: "v2.4.0-rc", DeployedAt: now.Add(-1 * time.Hour)},
		{ProjectID: mine.ProjectID, Environment: "production", Release: "infra-7", DeployedAt: now.Add(-2 * time.Hour)},
		{ProjectID: mine.ProjectID, AppID: app, Environment: "production", Release: "v2.5.0", DeployedAt: now.Add(-10 * time.Minute)},
		{ProjectID: theirs.ProjectID, AppID: theirs.AppID, Environment: "production", Release: "secret", DeployedAt: deployed},
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

	get := func(key, path string, want int, out any) {
		t.Helper()
		r, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		r.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != want {
			t.Fatalf("GET %s: status %d, want %d: %s", path, resp.StatusCode, want, body)
		}
		if out != nil {
			if err := json.Unmarshal(body, out); err != nil {
				t.Fatal(err)
			}
		}
	}

	// The list: paging, the app and environment filters, and an id per deploy.
	var all deployListOut
	get(mine.ReadKey, "/api/v1/deploys/changes?range=6h", http.StatusOK, &all)
	if all.Total != 5 || len(all.Deploys) != 5 {
		t.Fatalf("all deploys = %+v", all)
	}
	ids := map[string]string{}
	for _, d := range all.Deploys {
		if d.ID == "" {
			t.Fatalf("deploy without id: %+v", d)
		}
		ids[d.Release] = d.ID
	}
	var appOnly deployListOut
	get(mine.ReadKey, "/api/v1/deploys/changes?range=6h&env=production&app="+app.String(), http.StatusOK, &appOnly)
	if appOnly.Total != 3 || len(appOnly.Deploys) != 3 || appOnly.Deploys[0].Release != "v2.5.0" {
		t.Fatalf("production deploys of the app = %+v", appOnly)
	}
	var page2 deployListOut
	get(mine.ReadKey, "/api/v1/deploys/changes?range=6h&limit=2&offset=2", http.StatusOK, &page2)
	if page2.Total != 5 || len(page2.Deploys) != 2 || page2.Deploys[0].ID != all.Deploys[2].ID {
		t.Fatalf("page 2 = %+v", page2)
	}
	var past deployListOut
	get(mine.ReadKey, "/api/v1/deploys/changes?range=6h&limit=2&offset=40", http.StatusOK, &past)
	if past.Total != 5 || len(past.Deploys) != 0 {
		t.Fatalf("past the end = %+v", past)
	}
	var otherApp deployListOut
	get(mine.ReadKey, "/api/v1/deploys/changes?range=6h&app="+uuid.NewString(), http.StatusOK, &otherApp)
	if otherApp.Total != 0 || len(otherApp.Deploys) != 0 {
		t.Fatalf("an unknown app = %+v", otherApp)
	}

	// The detail of v2.4.0: neighbours of the same app and environment only.
	var d deployDetailOut
	get(mine.ReadKey, "/api/v1/deploys/"+ids["v2.4.0"], http.StatusOK, &d)
	if d.Deploy.ID != ids["v2.4.0"] || d.Deploy.Commit != "abc123" || d.Deploy.AfterPartial || d.AfterMinutes != 60 || d.WindowMinutes != 60 {
		t.Errorf("deploy = %+v", d.Deploy)
	}
	if d.Previous == nil || d.Previous.Release != "v2.3.0" || d.Next == nil || d.Next.Release != "v2.5.0" || d.Next.ID != ids["v2.5.0"] {
		t.Errorf("previous = %+v next = %+v", d.Previous, d.Next)
	}
	if d.Deploy.Before.Requests != 13 || d.Deploy.After.Requests != 6 {
		t.Errorf("before = %+v after = %+v", d.Deploy.Before, d.Deploy.After)
	}
	if len(d.Series) != 121 {
		t.Fatalf("series has %d minutes, want 121", len(d.Series))
	}
	var minute, total uint64
	for _, p := range d.Series {
		total += p.Requests
		if p.TS.Equal(d.DeployMinute) {
			minute = p.ServerErrors
		}
	}
	if minute != 1 || total != 20 {
		t.Errorf("deploy minute 5xx = %d, series requests = %d", minute, total)
	}

	// The latest deploy: its after window is still open, and it has no next.
	var latest deployDetailOut
	get(mine.ReadKey, "/api/v1/deploys/"+ids["v2.5.0"], http.StatusOK, &latest)
	if !latest.Deploy.AfterPartial || latest.AfterMinutes < 8 || latest.AfterMinutes > 11 || latest.Next != nil || latest.Previous == nil {
		t.Errorf("latest = partial %v, %d min, next %+v, previous %+v", latest.Deploy.AfterPartial, latest.AfterMinutes, latest.Next, latest.Previous)
	}

	// What changed with v2.4.0.
	var c deployComparisonOut
	get(mine.ReadKey, "/api/v1/deploys/"+ids["v2.4.0"]+"/comparison", http.StatusOK, &c)
	if len(c.Endpoints) != 3 {
		t.Fatalf("endpoints = %+v", c.Endpoints)
	}
	if e := c.Endpoints[0]; e.Path != "/orders" || e.Change != "compared" || e.Before.Requests != 10 || e.Before.ServerErrors != 1 ||
		e.After.Requests != 4 || e.After.ClientErrors != 1 || e.After.ServerErrors != 1 {
		t.Errorf("first endpoint = %+v", e)
	}
	if c.Endpoints[1].Path != "/new" || c.Endpoints[1].Change != "new" || c.Endpoints[2].Path != "/legacy" || c.Endpoints[2].Change != "gone" {
		t.Errorf("endpoints = %+v", c.Endpoints)
	}
	statuses := map[uint16][3]uint64{}
	for _, s := range c.Statuses {
		n := uint64(0)
		if s.New {
			n = 1
		}
		statuses[s.StatusCode] = [3]uint64{s.Before, s.After, n}
	}
	if len(statuses) != 3 || statuses[503] != [3]uint64{0, 1, 1} || statuses[404] != [3]uint64{0, 1, 1} || statuses[500] != [3]uint64{1, 0, 0} {
		t.Errorf("statuses = %+v", c.Statuses)
	}
	if len(c.Exceptions) != 2 || c.Exceptions[0].ExceptionType != "KeyError" || !c.Exceptions[0].New || c.Exceptions[0].After != 2 ||
		c.Exceptions[0].Path != "/orders" || c.Exceptions[1].ExceptionType != "ValueError" || c.Exceptions[1].New {
		t.Errorf("exceptions = %+v", c.Exceptions)
	}
	if c.ConsumersAffected != 1 || len(c.Consumers) != 1 || c.Consumers[0].ConsumerID != "acme" || c.Consumers[0].ConsumerName != "acme Inc" ||
		c.Consumers[0].AfterErrors != 2 || c.Consumers[0].BeforeErrors != 0 {
		t.Errorf("consumers = %d %+v", c.ConsumersAffected, c.Consumers)
	}

	// Another project's deploy, an unknown id and a malformed one.
	var theirList deployListOut
	get(theirs.ReadKey, "/api/v1/deploys/changes?range=6h", http.StatusOK, &theirList)
	if len(theirList.Deploys) != 1 {
		t.Fatalf("their deploys = %+v", theirList)
	}
	get(mine.ReadKey, "/api/v1/deploys/"+theirList.Deploys[0].ID, http.StatusNotFound, nil)
	get(mine.ReadKey, "/api/v1/deploys/"+theirList.Deploys[0].ID+"/comparison", http.StatusNotFound, nil)
	get(mine.ReadKey, "/api/v1/deploys/ffffffffffffffff", http.StatusNotFound, nil)
	get(mine.ReadKey, "/api/v1/deploys/NOT-AN-ID", http.StatusUnprocessableEntity, nil)
	get(theirs.ReadKey, "/api/v1/deploys/"+theirList.Deploys[0].ID, http.StatusOK, nil)
	// An ingest key cannot read deploys.
	get(mine.APIKey, "/api/v1/deploys/"+ids["v2.4.0"], http.StatusForbidden, nil)
}
