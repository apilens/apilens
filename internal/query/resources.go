package query

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/server"
)

// AppResourcesPath is the path of an app's runtime resources series (M7).
const AppResourcesPath = server.APIPrefix + "/apps/{id}/resources"

// resourcesRollupAfter is the longest window read from raw heartbeat rows;
// longer windows read the hourly rollup app_instance_resources_1h.
const resourcesRollupAfter = 48 * time.Hour

// resourcesRawRetention is how far back raw resource rows reach (retention
// signal resources, 30 days by default).
const resourcesRawRetention = 30 * 24 * time.Hour

// AppStore is the control-plane subset the per-app operations read to check
// the app belongs to the caller's project; *db.Queries satisfies it.
type AppStore interface {
	GetProjectApp(ctx context.Context, arg db.GetProjectAppParams) (db.GetProjectAppRow, error)
}

// projectApp resolves the app id of the path within the caller's project:
// 404 for an unknown app, a malformed id or another project's app.
func (s *Service) projectApp(ctx context.Context, rawID string) (scope, db.GetProjectAppRow, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return scope{}, db.GetProjectAppRow{}, err
	}
	store, ok := s.catalog.(AppStore)
	if !ok {
		return scope{}, db.GetProjectAppRow{}, huma.Error503ServiceUnavailable("app lookup unavailable")
	}
	id, err := uuid.Parse(rawID)
	if err != nil {
		return scope{}, db.GetProjectAppRow{}, huma.Error404NotFound("app not found")
	}
	app, err := store.GetProjectApp(ctx, db.GetProjectAppParams{ID: id, ProjectID: p.ProjectID})
	if errors.Is(err, pgx.ErrNoRows) {
		return scope{}, db.GetProjectAppRow{}, huma.Error404NotFound("app not found")
	}
	if err != nil {
		return scope{}, db.GetProjectAppRow{}, internalError("app lookup", err)
	}
	return p, app, nil
}

// resourceWindow is a resolved window of the resources operations.
type resourceWindow struct {
	name     string
	from, to time.Time
	bucket   time.Duration
	rollup   bool
}

var resourceRanges = map[string]struct{ span, bucket time.Duration }{
	"1h":  {time.Hour, time.Minute},
	"6h":  {6 * time.Hour, 5 * time.Minute},
	"24h": {24 * time.Hour, 15 * time.Minute},
	"7d":  {7 * 24 * time.Hour, time.Hour},
	"30d": {30 * 24 * time.Hour, 6 * time.Hour},
}

func resolveResourceWindow(name string, now time.Time) (resourceWindow, error) {
	name = cmp.Or(name, "24h")
	r, ok := resourceRanges[name]
	if !ok {
		return resourceWindow{}, huma.Error422UnprocessableEntity("range must be one of 1h, 6h, 24h, 7d, 30d")
	}
	to := now.UTC().Truncate(r.bucket).Add(r.bucket)
	return resourceWindow{name: name, from: to.Add(-r.span), to: to, bucket: r.bucket, rollup: r.span > resourcesRollupAfter}, nil
}

// metricSource is where one metric is read from: a gauge's avg/min/max keys
// (a scalar uses the same key thrice) in the container or the process
// scope. per divides the value by another key as a percent (mem_pct); sum
// adds several keys (Python GC pause over generations).
type metricSource struct {
	container     bool
	avg, min, max string
	per           string
	sum           []string
}

func gaugeSource(container bool, base string) metricSource {
	return metricSource{container: container, avg: base + ".avg", min: base + ".min", max: base + ".max"}
}

func scalarSource(container bool, key string) metricSource {
	return metricSource{container: container, avg: key, min: key, max: key}
}

// resourceMetric is one series of the resources operation. Sources are
// tried in order per heartbeat row: the first one measured is used.
type resourceMetric struct {
	unit    string
	sources []metricSource
	limit   string // metric key of the limit in the scope; "" for none
}

// ResourceMetricNames are the series GET /apps/{id}/resources serves.
var ResourceMetricNames = []string{
	"cpu_pct", "cpu_cores", "mem_working_set", "mem_rss", "mem_pss", "mem_pct", "throttled_ratio",
	"event_loop_p99", "elu", "heap_used", "gc_pause", "threads", "pool_used",
}

var resourceMetrics = map[string]resourceMetric{
	"cpu_pct":   {unit: "percent", sources: []metricSource{gaugeSource(true, "container.cpu.pct_of_limit"), gaugeSource(false, "process.cpu.pct_of_limit")}},
	"cpu_cores": {unit: "cores", sources: []metricSource{gaugeSource(true, "container.cpu.cores_used"), gaugeSource(false, "process.cpu.cores_used")}, limit: "container.cpu.limit_cores"},
	"mem_working_set": {unit: "bytes", limit: "container.memory.limit", sources: []metricSource{
		gaugeSource(true, "container.memory.working_set"), gaugeSource(true, "container.memory.current"),
	}},
	"mem_rss": {unit: "bytes", sources: []metricSource{gaugeSource(false, "process.memory.rss")}, limit: "container.memory.limit"},
	"mem_pss": {unit: "bytes", sources: []metricSource{gaugeSource(false, "process.memory.pss")}, limit: "container.memory.limit"},
	"mem_pct": {unit: "percent", sources: []metricSource{
		withPer(gaugeSource(true, "container.memory.working_set"), "container.memory.limit"),
		withPer(gaugeSource(true, "container.memory.current"), "container.memory.limit"),
	}},
	"throttled_ratio": {unit: "ratio", sources: []metricSource{scalarSource(true, "container.cpu.throttled_ratio")}},
	"event_loop_p99":  {unit: "ms", sources: []metricSource{scalarSource(false, "node.event_loop_delay_ms.p99")}},
	"elu":             {unit: "ratio", sources: []metricSource{gaugeSource(false, "node.elu")}},
	"heap_used":       {unit: "bytes", sources: []metricSource{gaugeSource(false, "jvm.heap_used"), gaugeSource(false, "node.heap_used")}, limit: "jvm.heap_max"},
	"gc_pause": {unit: "ms", sources: []metricSource{
		scalarSource(false, "jvm.gc.pause_ms_sum"), scalarSource(false, "node.gc.pause_ms_sum"),
		{sum: []string{"python.gc.gen0.pause_ms_sum", "python.gc.gen1.pause_ms_sum", "python.gc.gen2.pause_ms_sum"}},
	}},
	"threads": {unit: "count", sources: []metricSource{
		gaugeSource(false, "jvm.threads"), gaugeSource(false, "process.threads"), gaugeSource(false, "python.threads"),
	}},
	"pool_used": {unit: "count", sources: []metricSource{scalarSource(false, "pools.used.last")}},
}

func withPer(s metricSource, per string) metricSource {
	s.per = per
	return s
}

// metricSQL renders metric map reads for raw rows (metrics) or the hourly
// rollup (metrics_sum/count/min/max). Keys are constants of this file,
// never input, so they are inlined as literals.
type metricSQL struct{ rollup bool }

func (m metricSQL) has(k string) string {
	if m.rollup {
		return fmt.Sprintf("mapContains(metrics_count, '%s')", k)
	}
	return fmt.Sprintf("mapContains(metrics, '%s')", k)
}

func (m metricSQL) avg(k string) string {
	if m.rollup {
		return fmt.Sprintf("(metrics_sum['%[1]s'] / metrics_count['%[1]s'])", k)
	}
	return fmt.Sprintf("metrics['%s']", k)
}

func (m metricSQL) extreme(k, fn string) string {
	if m.rollup {
		return fmt.Sprintf("if(mapContains(metrics_%[2]s, '%[1]s'), metrics_%[2]s['%[1]s'], NULL)", k, fn)
	}
	return fmt.Sprintf("if(mapContains(metrics, '%[1]s'), metrics['%[1]s'], NULL)", k)
}

func (m metricSQL) weight(k string) string {
	if m.rollup {
		return fmt.Sprintf("toFloat64(metrics_count['%s'])", k)
	}
	return "1."
}

// columns renders one source as (present, avg, min, max, weight).
func (m metricSQL) columns(s metricSource) (present, avg, mn, mx, w string) {
	if len(s.sum) > 0 {
		n := len(s.sum)
		has, vals, mins, maxs := make([]string, 0, n), make([]string, 0, n), make([]string, 0, n), make([]string, 0, n)
		for _, k := range s.sum {
			has = append(has, m.has(k))
			vals = append(vals, fmt.Sprintf("if(%s, %s, 0)", m.has(k), m.avg(k)))
			mins = append(mins, fmt.Sprintf("ifNull(%s, 0)", m.extreme(k, "min")))
			maxs = append(maxs, fmt.Sprintf("ifNull(%s, 0)", m.extreme(k, "max")))
		}
		ws := make([]string, 0, len(s.sum))
		for _, k := range s.sum {
			ws = append(ws, m.weight(k))
		}
		weight := "1."
		if m.rollup {
			weight = "greatest(" + strings.Join(ws, ", ") + ")"
		}
		return "(" + strings.Join(has, " OR ") + ")", "(" + strings.Join(vals, " + ") + ")",
			"(" + strings.Join(mins, " + ") + ")", "(" + strings.Join(maxs, " + ") + ")", weight
	}
	present, avg, mn, mx, w = m.has(s.avg), m.avg(s.avg), m.extreme(s.min, "min"), m.extreme(s.max, "max"), m.weight(s.avg)
	if s.per != "" {
		present = fmt.Sprintf("(%s AND %s AND %s > 0)", present, m.has(s.per), m.avg(s.per))
		scale := func(v string) string { return fmt.Sprintf("(%s / %s * 100)", v, m.avg(s.per)) }
		avg, mn, mx = scale(avg), scale(mn), scale(mx)
	}
	return present, avg, mn, mx, w
}

// seriesKey is what one series is kept per: the container (every worker of
// a container reports the same container numbers, counted once) or the
// process.
func seriesKey(container bool) string {
	if container {
		return "concat('c:', if(container_id = '', instance_id, container_id))"
	}
	return "concat('p:', instance_id)"
}

// rowColumns renders a metric's per-row columns: the series key, avg, min,
// max and weight from the first measured source, NULL avg when none is.
func (m metricSQL) rowColumns(metric resourceMetric) string {
	n := 2 * len(metric.sources)
	keys, avgs, mins, maxs, ws := make([]string, 0, n), make([]string, 0, n), make([]string, 0, n), make([]string, 0, n), make([]string, 0, n)
	for _, s := range metric.sources {
		p, a, mn, mx, w := m.columns(s)
		keys = append(keys, p, seriesKey(s.container))
		avgs = append(avgs, p, "toNullable(toFloat64("+a+"))")
		mins = append(mins, p, "toNullable(toFloat64("+mn+"))")
		maxs = append(maxs, p, "toNullable(toFloat64("+mx+"))")
		ws = append(ws, p, w)
	}
	multi := func(parts []string, otherwise string) string {
		return "multiIf(" + strings.Join(parts, ", ") + ", " + otherwise + ")"
	}
	return multi(keys, "''") + " AS rk, " + multi(avgs, "NULL") + " AS ra, " + multi(mins, "NULL") + " AS rmn, " +
		multi(maxs, "NULL") + " AS rmx, " + multi(ws, "0.") + " AS rw"
}

// ResourcePoint is one bucket of a resources series.
type ResourcePoint struct {
	T         time.Time `json:"t" doc:"Start of the bucket."`
	Avg       *float64  `json:"avg" required:"true" nullable:"true" doc:"Mean over the bucket: per container (container metrics) or process (process metrics) first, then across them; null when nothing reported (a gap, never zero)."`
	Min       *float64  `json:"min" required:"true" nullable:"true" doc:"Lowest sample of any container or process in the bucket; null for a gap."`
	Max       *float64  `json:"max" required:"true" nullable:"true" doc:"Highest sample of any container or process in the bucket; null for a gap."`
	Instances int       `json:"instances" doc:"Containers (container metrics) or processes (process metrics) that reported in the bucket; 0 for a gap."`
}

// ResourceSeries is a runtime resources metric of an app over a window.
type ResourceSeries struct {
	Metric        string          `json:"metric" doc:"The metric of the series."`
	Unit          string          `json:"unit" enum:"percent,cores,bytes,ms,ratio,count" doc:"Unit of avg, min, max and limit."`
	Range         string          `json:"range" doc:"Time range of the response."`
	From          time.Time       `json:"from" doc:"Start of the window (inclusive, bucket-aligned)."`
	To            time.Time       `json:"to" doc:"End of the window (exclusive, bucket-aligned)."`
	BucketSeconds int             `json:"bucket_seconds" doc:"Width of each bucket, in seconds."`
	Limit         *float64        `json:"limit" required:"true" nullable:"true" doc:"The limit of the scope in the series' unit, when known: the container memory limit (memory in bytes), the CPU limit in cores (cpu_cores) or the JVM max heap (heap_used); the highest of the containers or processes in scope, from their latest heartbeat. Null when unknown and for percents and ratios."`
	Points        []ResourcePoint `json:"points" doc:"One point per bucket of the window, oldest first; buckets without heartbeats are null, not zero."`
}

type resourcesInput struct {
	ProjectInput
	ID          string `path:"id" format:"uuid" doc:"The app's id."`
	Metric      string `query:"metric" required:"true" enum:"cpu_pct,cpu_cores,mem_working_set,mem_rss,mem_pss,mem_pct,throttled_ratio,event_loop_p99,elu,heap_used,gc_pause,threads,pool_used" doc:"The metric to read."`
	Range       string `query:"range" enum:"1h,6h,24h,7d,30d" default:"24h" doc:"Time range ending now. Windows longer than 48 hours read the hourly rollup."`
	Environment string `query:"environment" maxLength:"64" doc:"Environment name; empty means all."`
	Env         string `query:"env" maxLength:"64" doc:"Alias of environment, as the traffic operations name it."`
	Instance    string `query:"instance" maxLength:"128" doc:"Only this SDK process (instance_id)."`
	Container   string `query:"container" maxLength:"128" doc:"Only this container (container_id)."`
}

type resourcesOutput struct {
	Body ResourceSeries
}

func registerResources(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "get-app-resources",
		Method:      http.MethodGet,
		Path:        AppResourcesPath,
		Summary:     "Runtime resources of an app over time",
		Description: "One CPU, memory or runtime metric of the app's SDK processes from their heartbeats, per bucket with the mean, " +
			"lowest and highest value and how many reported. Container metrics (cpu_pct, cpu_cores, mem_working_set, mem_pct, throttled_ratio) " +
			"are kept once per container, so forked workers of one container are never added up; cpu_pct and cpu_cores fall back to the " +
			"process's own numbers outside a container. Process metrics are averaged over the processes. Buckets without heartbeats are " +
			"null (gaps), never zero. Units: cpu_pct, mem_pct percent; cpu_cores cores; mem_*, heap_used bytes; event_loop_p99 and " +
			"gc_pause (stop-the-world pause per heartbeat window) ms; elu, throttled_ratio 0 to 1; threads, pool_used count. " +
			"An app that is not in the project answers 404." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.resources)
}

// resourceScope is the WHERE clause of the resources reads of an app.
func resourceScope(project, app uuid.UUID, env, instance, container string) (string, []any) {
	where, args := tenantFilter(project, env)
	where += " AND app_id = ?"
	args = append(args, app)
	if instance != "" {
		where += " AND instance_id = ?"
		args = append(args, instance)
	}
	if container != "" {
		where += " AND container_id = ?"
		args = append(args, container)
	}
	return where, args
}

func (s *Service) resources(ctx context.Context, in *resourcesInput) (*resourcesOutput, error) {
	p, app, err := s.projectApp(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	metric, ok := resourceMetrics[in.Metric]
	if !ok {
		return nil, huma.Error422UnprocessableEntity("unknown metric " + in.Metric)
	}
	now := s.now().UTC()
	w, err := resolveResourceWindow(in.Range, now)
	if err != nil {
		return nil, err
	}
	where, args := resourceScope(p.ProjectID, app.ID, cmp.Or(in.Environment, in.Env), in.Instance, in.Container)
	out := &resourcesOutput{Body: ResourceSeries{
		Metric: in.Metric, Unit: metric.unit, Range: w.name, From: w.from, To: w.to,
		BucketSeconds: int(w.bucket.Seconds()), Points: make([]ResourcePoint, 0, int(w.to.Sub(w.from)/w.bucket)),
	}}
	got := map[int64]ResourcePoint{}
	if s.ch != nil {
		qctx, cancel := queryCtx(ctx)
		defer cancel()
		if got, err = s.resourcePoints(qctx, metric, w, where, args); err != nil {
			return nil, err
		}
		if metric.limit != "" {
			if out.Body.Limit, err = s.resourceLimit(qctx, metric.limit, w, now, where, args); err != nil {
				return nil, err
			}
		}
	}
	for t := w.from; t.Before(w.to); t = t.Add(w.bucket) {
		pt, ok := got[t.Unix()]
		if !ok {
			pt = ResourcePoint{}
		}
		pt.T = t
		out.Body.Points = append(out.Body.Points, pt)
	}
	return out, nil
}

// resourcePoints reads a metric per bucket: one value per series key
// (container or process) per bucket first, then mean, min and max across.
func (s *Service) resourcePoints(ctx context.Context, metric resourceMetric, w resourceWindow, where string, args []any) (map[int64]ResourcePoint, error) {
	m := metricSQL{rollup: w.rollup}
	table, tcol := "app_instance_resources", "ts"
	if w.rollup {
		table, tcol = "app_instance_resources_1h", "bucket"
	}
	seconds := int(w.bucket.Seconds())
	// table, column, bucket and metric columns are constants of this file.
	q := fmt.Sprintf(`
		SELECT t, avg(ka), min(kmn), max(kmx), toUInt64(count())
		FROM (
			SELECT toStartOfInterval(%[1]s, INTERVAL %[2]d SECOND) AS t, rk,
			       sum(ra * rw) / sum(rw) AS ka, min(rmn) AS kmn, max(rmx) AS kmx
			FROM (SELECT %[1]s, %[3]s FROM %[4]s WHERE %[5]s AND %[1]s >= ? AND %[1]s < ?)
			WHERE ra IS NOT NULL AND rw > 0
			GROUP BY t, rk
		)
		GROUP BY t ORDER BY t`, tcol, seconds, m.rowColumns(metric), table, where)
	rows, err := s.ch.Query(ctx, q, append(append([]any{}, args...), w.from, w.to)...)
	if err != nil {
		return nil, internalError("resources", err)
	}
	defer func() { _ = rows.Close() }()
	got := map[int64]ResourcePoint{}
	for rows.Next() {
		var (
			t           time.Time
			avg, mn, mx *float64
			n           uint64
		)
		if err := rows.Scan(&t, &avg, &mn, &mx, &n); err != nil {
			return nil, internalError("resources", err)
		}
		got[t.UTC().Unix()] = ResourcePoint{Avg: finitePtr(avg), Min: finitePtr(mn), Max: finitePtr(mx), Instances: int(n)}
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("resources", err)
	}
	return got, nil
}

// resourceLimit is the highest latest limit of the containers or processes
// in scope; raw rows reach back 30 days, which covers every window.
func (s *Service) resourceLimit(ctx context.Context, key string, w resourceWindow, now time.Time, where string, args []any) (*float64, error) {
	from := w.from
	if oldest := now.Add(-resourcesRawRetention); from.Before(oldest) {
		from = oldest
	}
	q := fmt.Sprintf(`
		SELECT maxOrNull(l) FROM (
			SELECT argMax(metrics['%[1]s'], ts) AS l FROM app_instance_resources
			WHERE %[2]s AND ts >= ? AND ts < ? AND mapContains(metrics, '%[1]s')
			GROUP BY %[3]s
		)`, key, where, seriesKey(strings.HasPrefix(key, "container.")))
	var limit *float64
	if err := s.ch.QueryRow(ctx, q, append(append([]any{}, args...), from, w.to)...).Scan(&limit); err != nil {
		return nil, internalError("resources limit", err)
	}
	return finitePtr(limit), nil
}

// finitePtr drops NaN and infinities (a division by a zero weight) and
// rounds to 4 decimals.
func finitePtr(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	r := math.Round(*v*10000) / 10000
	return &r
}
