//go:build integration

package query_test

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
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
	"github.com/apilens/apilens/internal/testutil/seed"
)

const mb = 1 << 20

// TestResourcesAPI runs the M7 resources operations against real Postgres
// and ClickHouse: the series (container dedupe, gaps, the hourly rollup,
// tenant scoping), the enriched instances of app status (identity,
// snapshot, sparklines, per-instance p95, signals, pages) and the instance
// events window.
func TestResourcesAPI(t *testing.T) {
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
	t.Cleanup(func() { _ = conn.Close() })
	q := db.New(pool)
	tenants := seed.TwoTenants(t, ctx, pool)
	mine, theirs := tenants.Mine, tenants.Theirs

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
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
	now := time.Now().UTC()
	minute := now.Truncate(time.Minute)

	t.Run("series", func(t *testing.T) { testResourceSeries(t, ctx, conn, get, mine, theirs, minute) })
	t.Run("instances", func(t *testing.T) { testEnrichedInstances(t, ctx, conn, q, get, mine, theirs, now) })
	t.Run("events", func(t *testing.T) { testInstanceEvents(t, ctx, q, get, mine, theirs, now) })
}

func insertResources(t *testing.T, ctx context.Context, conn driver.Conn, rows []pipeline.ResourceRow) {
	t.Helper()
	if err := pipeline.ClickHouseInserters(conn).Resources(ctx, rows); err != nil {
		t.Fatal(err)
	}
}

func gauge(m map[string]float64, base string, v float64) map[string]float64 {
	m[base+".min"], m[base+".avg"], m[base+".max"], m[base+".last"] = v, v, v, v
	return m
}

func testResourceSeries(t *testing.T, ctx context.Context, conn driver.Conn, get func(string, string, any) int, mine, theirs bootstrap.Result, minute time.Time) {
	// Container c1 runs 4 forked workers, c2 one; each worker reports its
	// container's numbers. Minute -7 has no heartbeat: a gap.
	var rows []pipeline.ResourceRow
	row := func(app bootstrap.Result, inst, container string, at time.Time, ws, rss float64) pipeline.ResourceRow {
		m := gauge(gauge(map[string]float64{"container.memory.limit": 1024 * mb}, "container.memory.working_set", ws), "process.memory.rss", rss)
		return pipeline.ResourceRow{ProjectID: app.ProjectID, AppID: app.AppID, Environment: "production", InstanceID: inst,
			Timestamp: at, WindowS: 60, ContainerID: container, Metrics: m}
	}
	for k := 5; k <= 10; k++ {
		if k == 7 {
			continue
		}
		at := minute.Add(-time.Duration(k)*time.Minute + 10*time.Second)
		for w := range 4 {
			rows = append(rows, row(mine, fmt.Sprintf("c1-w%d", w), "c1", at, 400*mb, 100*mb))
		}
		rows = append(rows, row(mine, "c2-w0", "c2", at, 200*mb, 300*mb))
		rows = append(rows, row(theirs, "secret", "c9", at, 9000*mb, 9000*mb))
	}
	insertResources(t, ctx, conn, rows)
	// A rollup row three days ago, which only the >48 h path can see.
	old := minute.Add(-72 * time.Hour).Truncate(time.Hour)
	if err := conn.Exec(ctx, `INSERT INTO app_instance_resources_1h
		(project_id, app_id, environment, instance_id, container_id, bucket, heartbeats, metrics_sum, metrics_count, metrics_min, metrics_max)
		VALUES (?, ?, 'production', 'old-w0', 'c-old', ?, 2, ?, ?, ?, ?)`,
		mine.ProjectID, mine.AppID, old,
		map[string]float64{"container.memory.working_set.avg": 1000 * mb},
		map[string]uint64{"container.memory.working_set.avg": 2},
		map[string]float64{"container.memory.working_set.min": 450 * mb},
		map[string]float64{"container.memory.working_set.max": 550 * mb}); err != nil {
		t.Fatal(err)
	}

	path := func(app bootstrap.Result, params string) string {
		return "/api/v1/apps/" + app.AppID.String() + "/resources?" + params
	}
	fetch := func(params string) query.ResourceSeries {
		t.Helper()
		var out query.ResourceSeries
		if code := get(mine.ReadKey, path(mine, params), &out); code != http.StatusOK {
			t.Fatalf("%s: status %d", params, code)
		}
		return out
	}
	at := func(s query.ResourceSeries, ts time.Time) query.ResourcePoint {
		t.Helper()
		for _, p := range s.Points {
			if p.T.Equal(ts) {
				return p
			}
		}
		t.Fatalf("no point at %v", ts)
		return query.ResourcePoint{}
	}

	ws := fetch("metric=mem_working_set&range=1h")
	if ws.Unit != "bytes" || ws.BucketSeconds != 60 || len(ws.Points) != 60 || ws.Limit == nil || *ws.Limit != 1024*mb {
		t.Fatalf("working set = unit %s bucket %d points %d limit %v", ws.Unit, ws.BucketSeconds, len(ws.Points), ws.Limit)
	}
	// One value per container: (400 + 200) / 2, never 4 × 400.
	p := at(ws, minute.Add(-5*time.Minute))
	if p.Avg == nil || *p.Avg != 300*mb || *p.Max != 400*mb || *p.Min != 200*mb || p.Instances != 2 {
		t.Fatalf("container point = %+v", p)
	}
	if g := at(ws, minute.Add(-7*time.Minute)); g.Avg != nil || g.Min != nil || g.Max != nil || g.Instances != 0 {
		t.Fatalf("gap = %+v, want nulls", g)
	}
	if c1 := at(fetch("metric=mem_working_set&range=1h&container=c1"), minute.Add(-5*time.Minute)); *c1.Avg != 400*mb || c1.Instances != 1 {
		t.Fatalf("c1 = %+v", c1)
	}
	// mem_pct: per container, 400/1024 and 200/1024.
	if pct := at(fetch("metric=mem_pct&range=1h"), minute.Add(-5*time.Minute)); pct.Avg == nil || *pct.Avg != 29.2969 || pct.Instances != 2 {
		t.Fatalf("mem_pct = %+v", pct)
	}
	// Process metric: averaged over the 5 workers, not summed.
	rss := fetch("metric=mem_rss&range=1h&environment=production")
	if r := at(rss, minute.Add(-6*time.Minute)); *r.Avg != 140*mb || *r.Max != 300*mb || r.Instances != 5 {
		t.Fatalf("rss = %+v", r)
	}
	if r := at(fetch("metric=mem_rss&range=1h&instance=c2-w0"), minute.Add(-6*time.Minute)); *r.Avg != 300*mb || r.Instances != 1 {
		t.Fatalf("rss one instance = %+v", r)
	}
	if s := fetch("metric=mem_rss&range=1h&env=staging"); at(s, minute.Add(-6*time.Minute)).Avg != nil {
		t.Fatal("staging has no data")
	}
	// A metric nobody reports: all gaps, no limit.
	if s := fetch("metric=event_loop_p99&range=1h"); s.Unit != "ms" || s.Limit != nil || at(s, minute.Add(-5*time.Minute)).Avg != nil {
		t.Fatalf("event loop = %+v", s)
	}

	// 7 days reads the hourly rollup: the old row shows, the recent hour is
	// still one value per container.
	week := fetch("metric=mem_working_set&range=7d")
	if week.BucketSeconds != 3600 || len(week.Points) != 168 {
		t.Fatalf("7d = bucket %d points %d", week.BucketSeconds, len(week.Points))
	}
	if o := at(week, old); o.Avg == nil || *o.Avg != 500*mb || *o.Min != 450*mb || *o.Max != 550*mb || o.Instances != 1 {
		t.Fatalf("rollup point = %+v", o)
	}
	if r := at(week, minute.Add(-5*time.Minute).Truncate(time.Hour)); r.Avg == nil || *r.Max != 400*mb {
		t.Fatalf("recent hour = %+v", r)
	}
	if d := fetch("metric=mem_working_set&range=24h"); d.BucketSeconds != 900 {
		t.Fatalf("24h bucket = %d", d.BucketSeconds)
	}

	for _, c := range []struct {
		what, key, path string
		want            int
	}{
		{"other project's app", mine.ReadKey, path(theirs, "metric=mem_rss"), http.StatusNotFound},
		{"unknown app", mine.ReadKey, "/api/v1/apps/" + uuid.NewString() + "/resources?metric=mem_rss", http.StatusNotFound},
		{"unknown metric", mine.ReadKey, path(mine, "metric=disk"), http.StatusUnprocessableEntity},
		{"no metric", mine.ReadKey, path(mine, ""), http.StatusUnprocessableEntity},
		{"bad range", mine.ReadKey, path(mine, "metric=mem_rss&range=90d"), http.StatusUnprocessableEntity},
		{"ingest key", mine.APIKey, path(mine, "metric=mem_rss"), http.StatusForbidden},
	} {
		if code := get(c.key, c.path, nil); code != c.want {
			t.Errorf("%s = %d, want %d", c.what, code, c.want)
		}
	}
	// Their own key sees their own container only.
	var their query.ResourceSeries
	if code := get(theirs.ReadKey, path(theirs, "metric=mem_working_set&range=1h"), &their); code != http.StatusOK {
		t.Fatalf("theirs = %d", code)
	}
	for _, p := range their.Points {
		if p.Avg != nil && (*p.Avg != 9000*mb || p.Instances != 1) {
			t.Fatalf("their point = %+v", p)
		}
	}
}

func testEnrichedInstances(t *testing.T, ctx context.Context, conn driver.Conn, q *db.Queries, get func(string, string, any) int, mine, theirs bootstrap.Result, now time.Time) {
	app := bootstrap.Result{ProjectID: mine.ProjectID}
	// A fresh app of the project keeps the series rows of the other subtest
	// out of the medians.
	appID, err := q.UpsertApp(ctx, db.UpsertAppParams{ID: uuid.New(), ProjectID: mine.ProjectID, Slug: "api", Name: "API"})
	if err != nil {
		t.Fatal(err)
	}
	app.AppID = appID.ID
	minute := now.Truncate(time.Minute)
	start := now.Add(-3 * time.Hour)

	snapshot := func(cpu, rss float64) []byte {
		b, _ := json.Marshal(map[string]any{"limit_source": "cgroup_v2", "container_id": "pod-a", "window_s": 60,
			"capabilities": []string{"process.cpu"}, "flags": []string{},
			"metrics": map[string]float64{"process.cpu.pct_of_limit.avg": cpu, "process.memory.rss.last": rss, "container.memory.limit": 1024 * mb}})
		return b
	}
	heartbeat := func(id string, seen time.Time, res []byte) {
		t.Helper()
		started := start
		up := now.Sub(start).Seconds()
		if err := q.UpsertAppInstance(ctx, db.UpsertAppInstanceParams{
			AppID: app.AppID, Environment: "production", InstanceID: id, ProjectID: app.ProjectID,
			SdkName: "apilenss", SdkVersion: "0.5.0", Stats: []byte(`{}`), SeenAt: seen,
			Hostname: "host-" + id, ContainerID: "ctr-" + id, PodName: "pod-" + id, PodUid: "uid-" + id, Namespace: "shop",
			NodeName: "node-1", Platform: "k8s", Region: "eu-west-1", ProcessStartTime: &started, UptimeS: &up, Resources: res,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Four live instances; w4 burns CPU and leaks; legacy has no resources.
	cpus := map[string]float64{"w1": 20, "w2": 22, "w3": 25, "w4": 90}
	for i, id := range []string{"w1", "w2", "w3", "w4"} {
		heartbeat(id, now.Add(-time.Duration(10+i)*time.Second), snapshot(cpus[id], 100*mb))
	}
	seed.Heartbeat(t, ctx, q, app, seed.Instance{InstanceID: "legacy", SDKName: "apilenss", SDKVersion: "0.1.0", SeenAt: now.Add(-time.Minute)})

	var rows []pipeline.ResourceRow
	for k := 0; k < 3*60; k++ { // one heartbeat a minute for 3 hours
		at := now.Add(-time.Duration(k) * time.Minute)
		for id, cpu := range cpus {
			rss := 100.0 * mb
			if id == "w4" {
				rss = 100*mb + 20*mb*at.Sub(start).Hours() // 20 MB/h
			}
			rows = append(rows, pipeline.ResourceRow{ProjectID: app.ProjectID, AppID: app.AppID, Environment: "production",
				InstanceID: id, Timestamp: at, WindowS: 60, ContainerID: "ctr-" + id,
				Metrics: gauge(gauge(map[string]float64{}, "process.cpu.pct_of_limit", cpu), "process.memory.rss", rss)})
		}
	}
	insertResources(t, ctx, conn, rows)

	// Requests of the last 15 full minutes: w1 fast (10..100 ms, one 500),
	// w2 slow (1 s).
	var reqs []pipeline.RequestRow
	for k := 1; k <= 10; k++ {
		at := minute.Add(-time.Duration(k)*time.Minute + 5*time.Second)
		code := uint16(200)
		if k == 1 {
			code = 500
		}
		reqs = append(reqs,
			pipeline.RequestRow{ProjectID: app.ProjectID, AppID: app.AppID, Environment: "production", Timestamp: at,
				Method: "GET", Path: "/x", RawPath: "/x", StatusCode: code, ResponseTimeMs: float64(10 * k), InstanceID: "w1"},
			pipeline.RequestRow{ProjectID: app.ProjectID, AppID: app.AppID, Environment: "production", Timestamp: at,
				Method: "GET", Path: "/x", RawPath: "/x", StatusCode: 200, ResponseTimeMs: 1000, InstanceID: "w2"})
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, reqs); err != nil {
		t.Fatal(err)
	}

	statusPath := func(params string) string { return "/api/v1/apps/" + app.AppID.String() + "/status" + params }
	var st query.AppStatus
	if code := get(mine.ReadKey, statusPath(""), &st); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if len(st.Instances) != 5 || st.NextCursor != nil {
		t.Fatalf("instances = %d, next %v", len(st.Instances), st.NextCursor)
	}
	by := map[string]query.AppInstance{}
	for _, in := range st.Instances {
		by[in.InstanceID] = in
		if len(in.Spark.CPUPct) != 60 || len(in.Spark.Mem) != 60 || in.Signals == nil {
			t.Fatalf("%s: spark %d/%d signals %v", in.InstanceID, len(in.Spark.CPUPct), len(in.Spark.Mem), in.Signals)
		}
	}
	w1 := by["w1"]
	if w1.Hostname != "host-w1" || w1.ContainerID != "ctr-w1" || w1.PodName != "pod-w1" || w1.PodUID != "uid-w1" || w1.Namespace != "shop" ||
		w1.NodeName != "node-1" || w1.Platform != "k8s" || w1.Region != "eu-west-1" || w1.ProcessStartTime == nil || w1.UptimeS == nil ||
		w1.EndedAt != nil || w1.EndedReason != "" {
		t.Errorf("w1 identity = %+v", w1)
	}
	if r := w1.Resources; r == nil || *r.CPUPct != 20 || *r.MemRSS != 100*mb || *r.MemLimit != 1024*mb || r.LimitSource != "cgroup_v2" {
		t.Errorf("w1 resources = %+v", r)
	}
	// The newest minute (or the one before, across a minute boundary).
	if last := cmp.Or(w1.Spark.CPUPct[59], w1.Spark.CPUPct[58]); last == nil || *last != 20 || w1.Spark.CPUPct[0] == nil {
		t.Errorf("w1 spark = %v", w1.Spark.CPUPct)
	}
	// Per-instance request stats.
	if r := w1.Requests; r == nil || r.RPM != round2(10.0/15) || r.ErrorPct != 10 || r.P95Ms < 80 || r.P95Ms > 100 {
		t.Errorf("w1 requests = %+v", r)
	}
	if r := by["w2"].Requests; r == nil || r.P95Ms != 1000 || r.ErrorPct != 0 {
		t.Errorf("w2 requests = %+v", r)
	}
	if by["w3"].Requests != nil {
		t.Errorf("w3 requests = %+v, want null", by["w3"].Requests)
	}
	// Old SDK: listed, without resources.
	if l, ok := by["legacy"]; !ok || l.Resources != nil || l.Requests != nil || l.Spark.CPUPct[59] != nil || len(l.Signals) != 0 {
		t.Errorf("legacy = %+v", l)
	}
	// Signals: w4 is noisy on CPU and leaks; the others are quiet. p95 has
	// only 2 instances with requests, too few peers.
	kinds := map[string]string{}
	for _, s := range by["w4"].Signals {
		kinds[s.Kind] = s.Metric
		if s.Kind == "leak" && (s.Value < 19 || s.Value > 21) {
			t.Errorf("leak = %+v", s)
		}
	}
	if kinds["noisy"] != "cpu_pct" || kinds["leak"] != "mem_rss" || len(by["w4"].Signals) != 2 {
		t.Errorf("w4 signals = %+v", by["w4"].Signals)
	}
	for _, id := range []string{"w1", "w2", "w3"} {
		if len(by[id].Signals) != 0 {
			t.Errorf("%s signals = %+v", id, by[id].Signals)
		}
	}

	// Pages of 2, newest first, until next_cursor is null.
	var seen []string
	params := "?limit=2"
	for range 5 {
		var page query.AppStatus
		if code := get(mine.ReadKey, statusPath(params), &page); code != http.StatusOK || len(page.Instances) > 2 {
			t.Fatalf("page %q = %d, %d instances", params, code, len(page.Instances))
		}
		for _, in := range page.Instances {
			seen = append(seen, in.InstanceID)
		}
		if page.NextCursor == nil {
			break
		}
		params = "?limit=2&cursor=" + url.QueryEscape(*page.NextCursor)
	}
	if len(seen) != 5 || seen[0] != "w1" || seen[4] != "legacy" {
		t.Errorf("paged = %v", seen)
	}
	if code := get(mine.ReadKey, statusPath("?cursor=nope"), nil); code != http.StatusUnprocessableEntity {
		t.Errorf("bad cursor = %d", code)
	}
	_ = theirs
}

func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

func testInstanceEvents(t *testing.T, ctx context.Context, q *db.Queries, get func(string, string, any) int, mine, theirs bootstrap.Result, now time.Time) {
	for _, e := range []struct {
		app  bootstrap.Result
		env  string
		kind string
		at   time.Time
	}{
		{mine, "production", "oom_kill", now.Add(-30 * time.Minute)},
		{mine, "production", "restart", now.Add(-3 * time.Hour)},
		{mine, "staging", "oom", now.Add(-5 * time.Hour)},
		{mine, "production", "suspected_oom", now.Add(-72 * time.Hour)},
		{theirs, "production", "restart", now.Add(-10 * time.Minute)},
	} {
		var err error
		if e.kind == "oom_kill" {
			err = q.RecordOOMKill(ctx, db.RecordOOMKillParams{ProjectID: e.app.ProjectID, AppID: e.app.AppID, Environment: e.env,
				InstanceID: "i-" + e.kind, ContainerID: "c1", PodName: "pod-1", At: e.at, Count: 2})
		} else {
			err = q.RecordInstanceEnded(ctx, db.RecordInstanceEndedParams{ProjectID: e.app.ProjectID, AppID: e.app.AppID, Environment: e.env,
				InstanceID: "i-" + e.kind, ContainerID: "c1", PodName: "pod-1", Kind: e.kind, At: e.at, ReplacedBy: "i-next", LastSeenAt: e.at.Add(-time.Minute)})
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	type events struct {
		Events []query.InstanceEvent `json:"events"`
	}
	path := func(app bootstrap.Result, params string) string {
		return "/api/v1/apps/" + app.AppID.String() + "/instance-events?" + params
	}
	fetch := func(params string) []query.InstanceEvent {
		t.Helper()
		var out events
		if code := get(mine.ReadKey, path(mine, params), &out); code != http.StatusOK {
			t.Fatalf("%s: %d", params, code)
		}
		return out.Events
	}
	if ev := fetch("range=1h"); len(ev) != 1 || ev[0].Kind != "oom_kill" || ev[0].InstanceID != "i-oom_kill" || ev[0].PodName != "pod-1" ||
		ev[0].ContainerID != "c1" || ev[0].Details["count"] != float64(2) {
		t.Fatalf("1h = %+v", ev)
	}
	if ev := fetch("range=24h"); len(ev) != 3 || ev[0].Kind != "oom_kill" || ev[1].Kind != "restart" || ev[2].Kind != "oom" ||
		ev[1].Details["replaced_by"] != "i-next" {
		t.Fatalf("24h = %+v (newest first)", ev)
	}
	if ev := fetch("range=24h&environment=staging"); len(ev) != 1 || ev[0].Kind != "oom" || ev[0].Environment != "staging" {
		t.Fatalf("staging = %+v", ev)
	}
	if ev := fetch("range=7d&env=production"); len(ev) != 3 || ev[2].Kind != "suspected_oom" {
		t.Fatalf("7d production = %+v", ev)
	}
	if code := get(mine.ReadKey, path(theirs, ""), nil); code != http.StatusNotFound {
		t.Errorf("other project's app = %d, want 404", code)
	}
}
