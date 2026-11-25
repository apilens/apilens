package query

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// Per-instance runtime resources on GET /apps/{id}/status (M7 E2/E3): the
// latest snapshot from Postgres, sparklines, request stats and signals from
// ClickHouse.

const (
	sparkPoints    = 60               // one-minute sparkline points
	requestsWindow = 15 * time.Minute // per-instance request stats
	noisyWindow    = 15 * time.Minute
	leakBucket     = 5 * time.Minute
)

// InstanceRuntime is the runtime headline of an instance; a field is left
// out when its runtime does not report it.
type InstanceRuntime struct {
	EventLoopP99 *float64 `json:"event_loop_p99,omitempty" doc:"Node.js event loop delay p99 over the heartbeat window, ms."`
	HeapUsed     *float64 `json:"heap_used,omitempty" doc:"Heap in use (JVM or V8) at the end of the window, bytes."`
	GCPauseMs    *float64 `json:"gc_pause_ms,omitempty" doc:"Stop-the-world GC pause over the window, ms (JVM, Node.js; Python summed over generations)."`
}

// InstanceResources is the latest resources snapshot of an instance (its
// last heartbeat with a resources block). A null value was not measured.
type InstanceResources struct {
	_              struct{}        `json:"-" nullable:"true"`
	LimitSource    string          `json:"limit_source" doc:"Where the CPU and memory limits come from: cgroup_v2, cgroup_v1, ecs, vm, host or none; empty when the SDK did not say."`
	CPUPct         *float64        `json:"cpu_pct" required:"true" nullable:"true" doc:"The process's CPU over the window as a percent of its effective limit, 0 to 100 (the container's when the process did not report its own)."`
	CPUCores       *float64        `json:"cpu_cores" required:"true" nullable:"true" doc:"CPU cores the process kept busy over the window (can exceed 1)."`
	CPULimitCores  *float64        `json:"cpu_limit_cores" required:"true" nullable:"true" doc:"The container's effective CPU limit in cores; null when there is none."`
	MemWorkingSet  *float64        `json:"mem_working_set" required:"true" nullable:"true" doc:"The container's memory working set at the end of the window, bytes (shared by every worker of the container)."`
	MemRSS         *float64        `json:"mem_rss" required:"true" nullable:"true" doc:"The process's resident set size at the end of the window, bytes."`
	MemPSS         *float64        `json:"mem_pss" required:"true" nullable:"true" doc:"The process's proportional set size, bytes (Linux only)."`
	MemLimit       *float64        `json:"mem_limit" required:"true" nullable:"true" doc:"The container's memory limit, bytes; null when there is none."`
	MemPct         *float64        `json:"mem_pct" required:"true" nullable:"true" doc:"mem_working_set (else mem_rss) as a percent of mem_limit; null without a limit."`
	ThrottledRatio *float64        `json:"throttled_ratio" required:"true" nullable:"true" doc:"Share of the container's CPU periods throttled over the window, 0 to 1."`
	Runtime        InstanceRuntime `json:"runtime" doc:"Runtime headline numbers."`
}

// InstanceSpark is an instance's last hour per minute, oldest first; a
// minute without a heartbeat is null.
type InstanceSpark struct {
	CPUPct []*float64 `json:"cpu_pct" nullable:"false" doc:"60 one-minute points of CPU percent of the limit (the process's, else its container's)."`
	Mem    []*float64 `json:"mem" nullable:"false" doc:"60 one-minute points of memory in bytes: the process's RSS, else its container's working set."`
}

// InstanceRequests are the requests an instance served in the last 15 full
// minutes.
type InstanceRequests struct {
	_        struct{} `json:"-" nullable:"true"`
	RPM      float64  `json:"rpm" doc:"Requests per minute."`
	P95Ms    float64  `json:"p95_ms" doc:"95th percentile response time, ms (t-digest estimate)."`
	ErrorPct float64  `json:"error_pct" doc:"Responses with status 400 or above, percent of requests."`
}

// snapshot is app_instances.resources as the heartbeat wrote it.
type snapshot struct {
	LimitSource string             `json:"limit_source"`
	Metrics     map[string]float64 `json:"metrics"`
}

func (s snapshot) get(keys ...string) *float64 {
	for _, k := range keys {
		if v, ok := s.Metrics[k]; ok && !math.IsNaN(v) && !math.IsInf(v, 0) {
			return &v
		}
	}
	return nil
}

// instanceResources reads the latest snapshot; nil for none (an SDK
// without resources, or a heartbeat that had none).
func instanceResources(raw []byte) (*InstanceResources, snapshot) {
	var snap snapshot
	if len(raw) == 0 || json.Unmarshal(raw, &snap) != nil || snap.Metrics == nil {
		return nil, snapshot{}
	}
	r := &InstanceResources{
		LimitSource:    snap.LimitSource,
		CPUPct:         snap.get("process.cpu.pct_of_limit.avg", "container.cpu.pct_of_limit.avg"),
		CPUCores:       snap.get("process.cpu.cores_used.avg", "container.cpu.cores_used.avg"),
		CPULimitCores:  snap.get("container.cpu.limit_cores"),
		MemWorkingSet:  snap.get("container.memory.working_set.last", "container.memory.working_set.avg", "container.memory.current.last"),
		MemRSS:         snap.get("process.memory.rss.last", "process.memory.rss.avg"),
		MemPSS:         snap.get("process.memory.pss.last", "process.memory.pss.avg"),
		MemLimit:       snap.get("container.memory.limit"),
		ThrottledRatio: snap.get("container.cpu.throttled_ratio"),
		Runtime: InstanceRuntime{
			EventLoopP99: snap.get("node.event_loop_delay_ms.p99"),
			HeapUsed:     snap.get("jvm.heap_used.last", "node.heap_used.last", "jvm.heap_used.avg", "node.heap_used.avg"),
			GCPauseMs:    snap.get("jvm.gc.pause_ms_sum", "node.gc.pause_ms_sum"),
		},
	}
	if r.Runtime.GCPauseMs == nil {
		var sum float64
		var seen bool
		for g := range 3 {
			if v := snap.get(fmt.Sprintf("python.gc.gen%d.pause_ms_sum", g)); v != nil {
				sum += *v
				seen = true
			}
		}
		if seen {
			r.Runtime.GCPauseMs = &sum
		}
	}
	used := r.MemWorkingSet
	if used == nil {
		used = r.MemRSS
	}
	if used != nil && r.MemLimit != nil && *r.MemLimit > 0 {
		pct := *used / *r.MemLimit * 100
		r.MemPct = finitePtr(&pct)
	}
	return r, snap
}

func emptySpark() InstanceSpark {
	return InstanceSpark{CPUPct: make([]*float64, sparkPoints), Mem: make([]*float64, sparkPoints)}
}

// statusCursor is the keyset position of a status page.
type statusCursor struct {
	SeenAt      time.Time `json:"s"`
	Environment string    `json:"e"`
	InstanceID  string    `json:"i"`
}

func (c statusCursor) encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeStatusCursor(raw string) (*statusCursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	var c statusCursor
	if err != nil || json.Unmarshal(b, &c) != nil || c.SeenAt.IsZero() {
		return nil, huma.Error422UnprocessableEntity("invalid cursor")
	}
	return &c, nil
}

// cpuExpr and memExpr are the per-row CPU percent and memory of an
// instance: its own process numbers first, else its container's.
const (
	cpuExpr = `multiIf(mapContains(metrics, 'process.cpu.pct_of_limit.avg'), metrics['process.cpu.pct_of_limit.avg'],
		mapContains(metrics, 'container.cpu.pct_of_limit.avg'), metrics['container.cpu.pct_of_limit.avg'], NULL)`
	memExpr = `multiIf(mapContains(metrics, 'process.memory.rss.last'), metrics['process.memory.rss.last'],
		mapContains(metrics, 'container.memory.working_set.last'), metrics['container.memory.working_set.last'], NULL)`
)

// enrichInstances adds sparklines, request stats and signals to the listed
// instances. Peers for the noisy signal are every instance of the app with
// data in the last 15 minutes, not only the listed page.
func (s *Service) enrichInstances(ctx context.Context, project, app uuid.UUID, now time.Time, list []AppInstance, snaps []snapshot) error {
	if s.ch == nil || len(list) == 0 {
		return nil
	}
	idx := make(map[instanceKey]int, len(list))
	ids := make([]string, 0, len(list))
	for i, in := range list {
		idx[instanceKey{in.Environment, in.InstanceID}] = i
		ids = append(ids, in.InstanceID)
	}
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	minute := now.Truncate(time.Minute)

	// Sparklines: the last 60 minutes including the current one.
	sparkFrom := minute.Add(-(sparkPoints - 1) * time.Minute)
	rows, err := s.ch.Query(qctx, `
		SELECT environment, instance_id, toStartOfMinute(ts) AS t, avgOrNull(`+cpuExpr+`), avgOrNull(`+memExpr+`)
		FROM app_instance_resources
		WHERE project_id = ? AND app_id = ? AND ts >= ? AND ts < ? AND instance_id IN ?
		GROUP BY environment, instance_id, t`, project, app, sparkFrom, minute.Add(time.Minute), ids)
	if err != nil {
		return internalError("instance sparklines", err)
	}
	for rows.Next() {
		var (
			env, id  string
			t        time.Time
			cpu, mem *float64
		)
		if err := rows.Scan(&env, &id, &t, &cpu, &mem); err != nil {
			_ = rows.Close()
			return internalError("instance sparklines", err)
		}
		i, ok := idx[instanceKey{env, id}]
		slot := int(t.UTC().Sub(sparkFrom) / time.Minute)
		if !ok || slot < 0 || slot >= sparkPoints {
			continue
		}
		list[i].Spark.CPUPct[slot], list[i].Spark.Mem[slot] = finitePtr(cpu), finitePtr(mem)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return internalError("instance sparklines", err)
	}

	// Requests over the last 15 full minutes, every instance of the app.
	p95 := map[instanceKey]float64{}
	rows, err = s.ch.Query(qctx, `
		SELECT environment, instance_id, sum(requests), sum(client_errors) + sum(server_errors), `+quantiles+`
		FROM api_requests_instance_1m
		WHERE project_id = ? AND app_id = ? AND bucket >= ? AND bucket < ?
		GROUP BY environment, instance_id`, project, app, minute.Add(-requestsWindow), minute)
	if err != nil {
		return internalError("instance requests", err)
	}
	for rows.Next() {
		var (
			env, id        string
			requests, errs uint64
			q              []float32
		)
		if err := rows.Scan(&env, &id, &requests, &errs, &q); err != nil {
			_ = rows.Close()
			return internalError("instance requests", err)
		}
		if requests == 0 {
			continue
		}
		k := instanceKey{env, id}
		p95[k] = quantile(q, 3)
		if i, ok := idx[k]; ok {
			list[i].Requests = &InstanceRequests{
				RPM:      round2(float64(requests) / requestsWindow.Minutes()),
				P95Ms:    p95[k],
				ErrorPct: round2(float64(errs) / float64(requests) * 100),
			}
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return internalError("instance requests", err)
	}

	// CPU over the last 15 minutes, every instance of the app.
	cpu := map[instanceKey]float64{}
	rows, err = s.ch.Query(qctx, `
		SELECT environment, instance_id, avgOrNull(`+cpuExpr+`) AS v
		FROM app_instance_resources
		WHERE project_id = ? AND app_id = ? AND ts >= ?
		GROUP BY environment, instance_id HAVING v IS NOT NULL`, project, app, now.Add(-noisyWindow))
	if err != nil {
		return internalError("instance cpu", err)
	}
	for rows.Next() {
		var (
			env, id string
			v       *float64
		)
		if err := rows.Scan(&env, &id, &v); err != nil {
			_ = rows.Close()
			return internalError("instance cpu", err)
		}
		if v = finitePtr(v); v != nil {
			cpu[instanceKey{env, id}] = *v
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return internalError("instance cpu", err)
	}
	for _, n := range []struct {
		metric string
		values map[instanceKey]float64
		gap    float64
	}{{"cpu_pct", cpu, noisyMinCPUPoints}, {"p95_ms", p95, noisyMinP95Ms}} {
		for k, ref := range noisyInstances(n.values, n.gap) {
			if i, ok := idx[k]; ok {
				list[i].Signals = append(list[i].Signals, noisySignal(n.metric, n.values[k], ref[0], int(ref[1])))
			}
		}
	}

	// Leaks: 5-minute means of the last 6 hours of the listed instances.
	series := map[instanceKey]*[4][]seriesPoint{}
	rows, err = s.ch.Query(qctx, `
		SELECT environment, instance_id, toStartOfInterval(ts, INTERVAL 300 SECOND) AS t,
		       avgOrNull(if(mapContains(metrics, 'jvm.heap_after_gc'), metrics['jvm.heap_after_gc'], NULL)),
		       avgOrNull(if(mapContains(metrics, 'node.heap_used.last'), metrics['node.heap_used.last'], NULL)),
		       avgOrNull(if(mapContains(metrics, 'process.memory.pss.last'), metrics['process.memory.pss.last'], NULL)),
		       avgOrNull(if(mapContains(metrics, 'process.memory.rss.last'), metrics['process.memory.rss.last'], NULL))
		FROM app_instance_resources
		WHERE project_id = ? AND app_id = ? AND ts >= ? AND instance_id IN ?
		GROUP BY environment, instance_id, t ORDER BY t`, project, app, now.Add(-leakWindow), ids)
	if err != nil {
		return internalError("instance memory trend", err)
	}
	for rows.Next() {
		var (
			env, id string
			t       time.Time
			vs      [4]*float64
		)
		if err := rows.Scan(&env, &id, &t, &vs[0], &vs[1], &vs[2], &vs[3]); err != nil {
			_ = rows.Close()
			return internalError("instance memory trend", err)
		}
		k := instanceKey{env, id}
		if _, ok := idx[k]; !ok {
			continue
		}
		if series[k] == nil {
			series[k] = &[4][]seriesPoint{}
		}
		for j, v := range vs {
			if v = finitePtr(v); v != nil {
				series[k][j] = append(series[k][j], seriesPoint{t: t.UTC(), v: *v})
			}
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return internalError("instance memory trend", err)
	}
	leakMetrics := [4]string{"heap_after_gc", "heap_used", "mem_pss", "mem_rss"}
	for k, ss := range series {
		i := idx[k]
		snap := snaps[i]
		limits := [4]*float64{snap.get("jvm.heap_max", "container.memory.limit"), nil, snap.get("container.memory.limit"), snap.get("container.memory.limit")}
		// The first metric with enough history is the one the runtime
		// reports best: heap after GC (JVM), V8 heap, then PSS, then RSS.
		for j, pts := range ss {
			if len(pts) < leakMinPoints {
				continue
			}
			if sig := leakSignal(leakMetrics[j], pts, limits[j]); sig != nil {
				list[i].Signals = append(list[i].Signals, *sig)
			}
			break
		}
	}
	return nil
}
