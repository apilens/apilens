package ingest

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Runtime resources (M7): every SDK samples its process and container every
// 15 s and sends the window's aggregate in the heartbeat's `resources` block.
// The contract is versioned (`v`), documented in apps/docs/ingest/heartbeat.mdx
// and pinned by testdata/resources/heartbeat_v1*.json, which the SDK tests
// share. A null (absent) value means "could not measure"; 0 is a measured
// zero, so nothing here ever fills a missing value with 0.

const (
	// ResourcesVersion is the only `resources.v` this edge understands; a
	// heartbeat with another version is accepted but its block is ignored.
	ResourcesVersion = 1

	maxResourcesSize   = 32 << 10
	maxResourceProcs   = 20
	maxResourcePools   = 10
	maxResourceGCs     = 16
	maxResourceMemPool = 32
	maxResourceFlags   = 16
	maxResourceCaps    = 32
	maxIdentityChars   = 253 // a DNS name: the longest pod, node or host name
	maxCommChars       = 15  // /proc/<pid>/comm
	maxResourceName    = 64
	// maxStartSkew bounds how far in the future a process start may claim
	// to be: more is a broken clock, and the value is dropped.
	maxStartSkew = 5 * time.Minute
)

// Gauge is one sampled value over the heartbeat window: the lowest, mean,
// highest and most recent sample. Any of them may be null.
type Gauge struct {
	Min  *float64 `json:"min,omitempty" nullable:"true"`
	Avg  *float64 `json:"avg,omitempty" nullable:"true"`
	Max  *float64 `json:"max,omitempty" nullable:"true"`
	Last *float64 `json:"last,omitempty" nullable:"true"`
}

// CPUUsage is CPU use of a process or container. cores_used is absolute
// (1.5 = one and a half cores busy); pct_of_limit is cores_used over the
// effective limit (cgroup quota, CPU affinity or cpuset, else host cores),
// 0 to 100.
type CPUUsage struct {
	CoresUsed  *Gauge `json:"cores_used,omitempty" doc:"CPU cores busy (can exceed 1)"`
	PctOfLimit *Gauge `json:"pct_of_limit,omitempty" doc:"Percent of the effective CPU limit, 0 to 100"`
}

// ProcessMemory is the SDK process's own memory, in bytes. pss and uss are
// Linux only (smaps_rollup) and sampled every 60 s.
type ProcessMemory struct {
	RSS *Gauge `json:"rss,omitempty" doc:"Resident set size, bytes"`
	PSS *Gauge `json:"pss,omitempty" doc:"Proportional set size, bytes (shared pages split between sharers)"`
	USS *Gauge `json:"uss,omitempty" doc:"Unique set size, bytes"`
}

// ProcessResources is the SDK process.
type ProcessResources struct {
	CPU     *CPUUsage      `json:"cpu,omitempty"`
	Memory  *ProcessMemory `json:"memory,omitempty"`
	Threads *Gauge         `json:"threads,omitempty" doc:"OS threads of the process"`
	FDs     *Gauge         `json:"fds,omitempty" doc:"Open file descriptors"`
}

// ContainerCPU is the cgroup's CPU: usage, its limit and throttling.
type ContainerCPU struct {
	CoresUsed      *Gauge   `json:"cores_used,omitempty"`
	PctOfLimit     *Gauge   `json:"pct_of_limit,omitempty"`
	LimitCores     *float64 `json:"limit_cores,omitempty" nullable:"true" doc:"Effective CPU limit in cores; null when there is none"`
	ThrottledRatio *float64 `json:"throttled_ratio,omitempty" nullable:"true" minimum:"0" maximum:"1" doc:"Share of CFS periods in the window that were throttled"`
	ThrottledUs    *float64 `json:"throttled_us,omitempty" nullable:"true" minimum:"0" doc:"Microseconds throttled in the window"`
}

// ContainerMemory is the cgroup's memory, in bytes. working_set is current
// minus inactive file cache: what the OOM killer and kubelet eviction look at.
type ContainerMemory struct {
	Current    *Gauge   `json:"current,omitempty"`
	WorkingSet *Gauge   `json:"working_set,omitempty"`
	Anon       *Gauge   `json:"anon,omitempty"`
	File       *Gauge   `json:"file,omitempty"`
	Swap       *Gauge   `json:"swap,omitempty"`
	Limit      *float64 `json:"limit,omitempty" nullable:"true" doc:"Memory limit in bytes; null when there is none"`
	OOMKill    *float64 `json:"oom_kill,omitempty" nullable:"true" minimum:"0" doc:"OOM kills in the cgroup during the window (memory.events oom_kill delta)"`
}

// ContainerResources is the cgroup the process runs in. Every worker of a
// container sends the same numbers; the server keeps one series per
// container_id and never sums workers.
type ContainerResources struct {
	ContainerID string           `json:"container_id,omitempty" maxLength:"128"`
	CPU         *ContainerCPU    `json:"cpu,omitempty"`
	Memory      *ContainerMemory `json:"memory,omitempty"`
}

// PythonGC is one CPython GC generation over the window (deltas).
type PythonGC struct {
	Generation    int      `json:"generation" minimum:"0" maximum:"2"`
	Collections   *float64 `json:"collections,omitempty" nullable:"true" minimum:"0"`
	Collected     *float64 `json:"collected,omitempty" nullable:"true" minimum:"0"`
	Uncollectable *float64 `json:"uncollectable,omitempty" nullable:"true" minimum:"0"`
	PauseMsSum    *float64 `json:"pause_ms_sum,omitempty" nullable:"true" minimum:"0"`
	PauseMsMax    *float64 `json:"pause_ms_max,omitempty" nullable:"true" minimum:"0"`
}

// PythonRuntime is CPython internals.
type PythonRuntime struct {
	GC         []PythonGC `json:"gc,omitempty" maxItems:"3"`
	Threads    *Gauge     `json:"threads,omitempty" doc:"Python threads (threading.active_count)"`
	GILEnabled *bool      `json:"gil_enabled,omitempty" nullable:"true"`
}

// Percentiles are the event loop delay percentiles of the window, in ms.
type Percentiles struct {
	P50 *float64 `json:"p50,omitempty" nullable:"true"`
	P99 *float64 `json:"p99,omitempty" nullable:"true"`
	Max *float64 `json:"max,omitempty" nullable:"true"`
}

// GCPauses is garbage collection over the window.
type GCPauses struct {
	Count      *float64 `json:"count,omitempty" nullable:"true" minimum:"0"`
	PauseMsSum *float64 `json:"pause_ms_sum,omitempty" nullable:"true" minimum:"0"`
	PauseMsMax *float64 `json:"pause_ms_max,omitempty" nullable:"true" minimum:"0"`
}

// NodeRuntime is Node.js (or Bun/Deno) internals. Memory in bytes.
type NodeRuntime struct {
	EventLoopDelayMs *Percentiles `json:"event_loop_delay_ms,omitempty"`
	ELU              *Gauge       `json:"elu,omitempty" doc:"Event loop utilization, 0 to 1"`
	HeapUsed         *Gauge       `json:"heap_used,omitempty"`
	HeapTotal        *Gauge       `json:"heap_total,omitempty"`
	External         *Gauge       `json:"external,omitempty"`
	ArrayBuffers     *Gauge       `json:"array_buffers,omitempty"`
	GC               *GCPauses    `json:"gc,omitempty"`
}

// JVMCollector is one garbage collector over the window. pause_ms is
// stop-the-world time; concurrent_ms is time of concurrent cycles (ZGC,
// Shenandoah, G1 concurrent), which is not a pause.
type JVMCollector struct {
	Name         string   `json:"name" maxLength:"64" example:"G1 Young Generation"`
	Count        *float64 `json:"count,omitempty" nullable:"true" minimum:"0"`
	PauseMs      *float64 `json:"pause_ms,omitempty" nullable:"true" minimum:"0"`
	ConcurrentMs *float64 `json:"concurrent_ms,omitempty" nullable:"true" minimum:"0"`
}

// JVMMemoryPool is one memory pool at the end of the window, bytes.
type JVMMemoryPool struct {
	Name      string   `json:"name" maxLength:"64" example:"G1 Old Gen"`
	Used      *float64 `json:"used,omitempty" nullable:"true"`
	Committed *float64 `json:"committed,omitempty" nullable:"true"`
	Max       *float64 `json:"max,omitempty" nullable:"true"`
}

// JVMRuntime is JVM internals. Memory in bytes.
type JVMRuntime struct {
	HeapUsed       *Gauge          `json:"heap_used,omitempty"`
	HeapCommitted  *Gauge          `json:"heap_committed,omitempty"`
	HeapMax        *float64        `json:"heap_max,omitempty" nullable:"true"`
	HeapAfterGC    *float64        `json:"heap_after_gc,omitempty" nullable:"true" doc:"Heap used right after the last full or old collection (leak trend)"`
	NonHeapUsed    *Gauge          `json:"non_heap_used,omitempty"`
	Metaspace      *Gauge          `json:"metaspace,omitempty"`
	DirectBuffers  *Gauge          `json:"direct_buffers,omitempty"`
	Threads        *Gauge          `json:"threads,omitempty" doc:"Platform threads"`
	VirtualThreads *Gauge          `json:"virtual_threads,omitempty"`
	GC             []JVMCollector  `json:"gc,omitempty" maxItems:"16"`
	Pools          []JVMMemoryPool `json:"pools,omitempty" maxItems:"32"`
}

// RuntimeResources holds the block of the SDK's language runtime.
type RuntimeResources struct {
	Python *PythonRuntime `json:"python,omitempty"`
	Node   *NodeRuntime   `json:"node,omitempty"`
	JVM    *JVMRuntime    `json:"jvm,omitempty"`
}

// ResourcePool is one database connection pool.
type ResourcePool struct {
	Name    string   `json:"name" maxLength:"64" example:"default"`
	Kind    string   `json:"kind,omitempty" maxLength:"32" example:"sqlalchemy"`
	Used    *Gauge   `json:"used,omitempty"`
	Idle    *float64 `json:"idle,omitempty" nullable:"true"`
	Max     *float64 `json:"max,omitempty" nullable:"true"`
	Pending *Gauge   `json:"pending,omitempty" doc:"Callers waiting for a connection"`
}

// ResourceProcess is one process in the SDK's own container. Never argv,
// environment or working directory: the edge drops any other key.
type ResourceProcess struct {
	PID    int64    `json:"pid" minimum:"0"`
	PPID   *int64   `json:"ppid,omitempty" nullable:"true"`
	Comm   string   `json:"comm" maxLength:"15" doc:"Process name (/proc/<pid>/comm)"`
	CPUPct *float64 `json:"cpu_pct,omitempty" nullable:"true" minimum:"0"`
	RSS    *float64 `json:"rss,omitempty" nullable:"true" minimum:"0"`
}

// Resources is the heartbeat's `resources` block (contract v1).
type Resources struct {
	V             int                 `json:"v" minimum:"1" example:"1" doc:"Contract version; this edge reads 1"`
	WindowS       *float64            `json:"window_s,omitempty" nullable:"true" doc:"Seconds the window covers"`
	N             *int                `json:"n,omitempty" nullable:"true" doc:"Samples taken in the window"`
	SamplerCostUs *float64            `json:"sampler_cost_us,omitempty" nullable:"true" doc:"Mean CPU microseconds one sample cost"`
	Capabilities  []string            `json:"capabilities,omitempty" maxItems:"32" doc:"What this process can measure, e.g. process.cpu, container.memory; empty on edge runtimes"`
	LimitSource   string              `json:"limit_source,omitempty" enum:"cgroup_v2,cgroup_v1,ecs,vm,host,none" doc:"Where CPU and memory limits come from"`
	Process       *ProcessResources   `json:"process,omitempty"`
	Container     *ContainerResources `json:"container,omitempty"`
	Runtime       *RuntimeResources   `json:"runtime,omitempty"`
	Pools         []ResourcePool      `json:"pools,omitempty" maxItems:"10"`
	Processes     []ResourceProcess   `json:"processes,omitempty" maxItems:"20" doc:"Top processes in the same container by RSS"`
	Flags         []string            `json:"flags,omitempty" maxItems:"16" doc:"Conditions of the window, e.g. freeze_gap, serverless, host_pid_namespace"`
}

// Identity is where the SDK process runs, resolved once per process start.
type Identity struct {
	Hostname         string     `json:"hostname,omitempty" maxLength:"253"`
	HostnameGuess    bool       `json:"hostname_guess,omitempty" doc:"True when the pod name is only inferred from the hostname"`
	ContainerID      string     `json:"container_id,omitempty" maxLength:"128"`
	PodName          string     `json:"pod_name,omitempty" maxLength:"253"`
	PodUID           string     `json:"pod_uid,omitempty" maxLength:"64"`
	Namespace        string     `json:"namespace,omitempty" maxLength:"253"`
	NodeName         string     `json:"node_name,omitempty" maxLength:"253"`
	Platform         string     `json:"platform,omitempty" enum:"k8s,ecs,cloud_run,app_engine,heroku,fly,lambda,vm,bare"`
	Region           string     `json:"region,omitempty" maxLength:"64"`
	ProcessStartTime *time.Time `json:"process_start_time,omitempty" nullable:"true"`
}

var (
	limitSources = map[string]bool{"cgroup_v2": true, "cgroup_v1": true, "ecs": true, "vm": true, "host": true, "none": true}
	platforms    = map[string]bool{"k8s": true, "ecs": true, "cloud_run": true, "app_engine": true, "heroku": true, "fly": true, "lambda": true, "vm": true, "bare": true}
	tokenRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.\-]{0,63}$`)
)

// sanitizeIdentity trims and bounds every field; unknown platforms are
// dropped rather than rejected, so a newer SDK never loses its heartbeat.
func sanitizeIdentity(id *Identity, now time.Time) Identity {
	if id == nil {
		return Identity{}
	}
	out := Identity{
		Hostname:      truncate(strings.TrimSpace(id.Hostname), maxIdentityChars),
		HostnameGuess: id.HostnameGuess,
		ContainerID:   truncate(strings.TrimSpace(id.ContainerID), 128),
		PodName:       truncate(strings.TrimSpace(id.PodName), maxIdentityChars),
		PodUID:        truncate(strings.TrimSpace(id.PodUID), 64),
		Namespace:     truncate(strings.TrimSpace(id.Namespace), maxIdentityChars),
		NodeName:      truncate(strings.TrimSpace(id.NodeName), maxIdentityChars),
		Region:        truncate(strings.TrimSpace(id.Region), 64),
	}
	if p := strings.TrimSpace(id.Platform); platforms[p] {
		out.Platform = p
	}
	if t := id.ProcessStartTime; t != nil && !t.IsZero() && !t.After(now.Add(maxStartSkew)) {
		u := t.UTC()
		out.ProcessStartTime = &u
	}
	return out
}

// ResourceSample is a validated resources block, flattened for storage.
type ResourceSample struct {
	WindowS     float64
	Samples     uint32
	LimitSource string
	ContainerID string
	// Metrics maps a dotted metric name to its value, e.g.
	// "process.cpu.pct_of_limit.avg". A metric that was not measured is
	// absent: there are no zeros standing in for nulls.
	Metrics      map[string]float64
	Capabilities []string
	Flags        []string
	// Pools and Processes are the per-item lists as compact JSON ("" when
	// absent), kept for the instance detail.
	Pools     string
	Processes string
}

// flattenResources validates a resources block and flattens it. A nil block,
// or one of an unknown version, yields ok=false and no error: the heartbeat
// itself still counts. Values that cannot be right (negative, NaN, a percent
// above the cores it could reach) are dropped one by one, never the block.
func flattenResources(r *Resources, raw []byte) (ResourceSample, bool, *apiError) {
	if r == nil {
		return ResourceSample{}, false, nil
	}
	if len(raw) > maxResourcesSize {
		return ResourceSample{}, false, errValidation("resources exceeds %d bytes", maxResourcesSize)
	}
	if r.V != ResourcesVersion {
		return ResourceSample{}, false, nil
	}
	s := ResourceSample{Metrics: map[string]float64{}}
	if r.WindowS != nil && finite(*r.WindowS) && *r.WindowS > 0 {
		s.WindowS = min(*r.WindowS, 3600)
	}
	if r.N != nil && *r.N > 0 {
		s.Samples = uint32(min(*r.N, 10_000))
	}
	if limitSources[r.LimitSource] {
		s.LimitSource = r.LimitSource
	}
	s.Capabilities = tokens(r.Capabilities, maxResourceCaps)
	s.Flags = tokens(r.Flags, maxResourceFlags)
	m := s.Metrics
	put := func(key string, v *float64) {
		if v != nil && finite(*v) && *v >= 0 {
			m[key] = *v
		}
	}
	gauge := func(key string, g *Gauge) {
		if g == nil {
			return
		}
		put(key+".min", g.Min)
		put(key+".avg", g.Avg)
		put(key+".max", g.Max)
		put(key+".last", g.Last)
	}
	// A percent of the limit is at most 100; cores_used is never clamped.
	pct := func(key string, g *Gauge) {
		gauge(key, g)
		for _, a := range []string{".min", ".avg", ".max", ".last"} {
			if v, ok := m[key+a]; ok && v > 100 {
				m[key+a] = 100
			}
		}
	}
	if p := r.Process; p != nil {
		if p.CPU != nil {
			gauge("process.cpu.cores_used", p.CPU.CoresUsed)
			pct("process.cpu.pct_of_limit", p.CPU.PctOfLimit)
		}
		if p.Memory != nil {
			gauge("process.memory.rss", p.Memory.RSS)
			gauge("process.memory.pss", p.Memory.PSS)
			gauge("process.memory.uss", p.Memory.USS)
		}
		gauge("process.threads", p.Threads)
		gauge("process.fds", p.FDs)
	}
	if c := r.Container; c != nil {
		s.ContainerID = truncate(strings.TrimSpace(c.ContainerID), 128)
		if c.CPU != nil {
			gauge("container.cpu.cores_used", c.CPU.CoresUsed)
			pct("container.cpu.pct_of_limit", c.CPU.PctOfLimit)
			put("container.cpu.limit_cores", c.CPU.LimitCores)
			if v := c.CPU.ThrottledRatio; v != nil && finite(*v) && *v >= 0 {
				m["container.cpu.throttled_ratio"] = math.Min(*v, 1)
			}
			put("container.cpu.throttled_us", c.CPU.ThrottledUs)
		}
		if c.Memory != nil {
			gauge("container.memory.current", c.Memory.Current)
			gauge("container.memory.working_set", c.Memory.WorkingSet)
			gauge("container.memory.anon", c.Memory.Anon)
			gauge("container.memory.file", c.Memory.File)
			gauge("container.memory.swap", c.Memory.Swap)
			// "No limit" sentinels (cgroup v1 page-aligned LONG_MAX and
			// friends) must never be stored as a limit.
			if v := c.Memory.Limit; v != nil && finite(*v) && *v > 0 && *v < 1<<62 {
				m["container.memory.limit"] = *v
			}
			put("container.memory.oom_kill", c.Memory.OOMKill)
		}
	}
	if rt := r.Runtime; rt != nil {
		if py := rt.Python; py != nil {
			for _, g := range py.GC {
				if g.Generation < 0 || g.Generation > 2 {
					continue
				}
				k := "python.gc.gen" + strconv.Itoa(g.Generation)
				put(k+".collections", g.Collections)
				put(k+".collected", g.Collected)
				put(k+".uncollectable", g.Uncollectable)
				put(k+".pause_ms_sum", g.PauseMsSum)
				put(k+".pause_ms_max", g.PauseMsMax)
			}
			gauge("python.threads", py.Threads)
			if py.GILEnabled != nil {
				v := 0.0
				if *py.GILEnabled {
					v = 1
				}
				m["python.gil_enabled"] = v
			}
		}
		if n := rt.Node; n != nil {
			if d := n.EventLoopDelayMs; d != nil {
				put("node.event_loop_delay_ms.p50", d.P50)
				put("node.event_loop_delay_ms.p99", d.P99)
				put("node.event_loop_delay_ms.max", d.Max)
			}
			gauge("node.elu", n.ELU)
			gauge("node.heap_used", n.HeapUsed)
			gauge("node.heap_total", n.HeapTotal)
			gauge("node.external", n.External)
			gauge("node.array_buffers", n.ArrayBuffers)
			if g := n.GC; g != nil {
				put("node.gc.count", g.Count)
				put("node.gc.pause_ms_sum", g.PauseMsSum)
				put("node.gc.pause_ms_max", g.PauseMsMax)
			}
		}
		if j := rt.JVM; j != nil {
			gauge("jvm.heap_used", j.HeapUsed)
			gauge("jvm.heap_committed", j.HeapCommitted)
			put("jvm.heap_max", j.HeapMax)
			put("jvm.heap_after_gc", j.HeapAfterGC)
			gauge("jvm.non_heap_used", j.NonHeapUsed)
			gauge("jvm.metaspace", j.Metaspace)
			gauge("jvm.direct_buffers", j.DirectBuffers)
			gauge("jvm.threads", j.Threads)
			gauge("jvm.virtual_threads", j.VirtualThreads)
			var pause, conc, count float64
			var seen bool
			for i, c := range j.GC {
				if i >= maxResourceGCs {
					break
				}
				for _, x := range []struct {
					v   *float64
					acc *float64
				}{{c.PauseMs, &pause}, {c.ConcurrentMs, &conc}, {c.Count, &count}} {
					if x.v != nil && finite(*x.v) && *x.v >= 0 {
						*x.acc += *x.v
						seen = true
					}
				}
			}
			if seen {
				m["jvm.gc.pause_ms_sum"], m["jvm.gc.concurrent_ms_sum"], m["jvm.gc.count"] = pause, conc, count
			}
		}
	}
	// Pools: the summed headline goes in Metrics, the list as JSON.
	if len(r.Pools) > 0 {
		pools := r.Pools[:min(len(r.Pools), maxResourcePools)]
		for i := range pools {
			pools[i].Name = truncate(strings.TrimSpace(pools[i].Name), maxResourceName)
			pools[i].Kind = truncate(strings.TrimSpace(pools[i].Kind), 32)
		}
		var used, pending float64
		var measured bool
		for _, p := range pools {
			if p.Used != nil && p.Used.Last != nil && finite(*p.Used.Last) && *p.Used.Last >= 0 {
				used += *p.Used.Last
				measured = true
			}
			if p.Pending != nil && p.Pending.Max != nil && finite(*p.Pending.Max) && *p.Pending.Max >= 0 {
				pending += *p.Pending.Max
			}
		}
		if measured {
			m["pools.used.last"], m["pools.pending.max"] = used, pending
		}
		s.Pools = compactJSON(pools)
	}
	if len(r.Processes) > 0 {
		procs := make([]ResourceProcess, 0, min(len(r.Processes), maxResourceProcs))
		for _, p := range r.Processes {
			if len(procs) == maxResourceProcs {
				break
			}
			if p.PID < 0 {
				continue
			}
			// Only the declared fields survive the round trip: any argv or
			// environment an SDK sent by mistake is not in the struct (D8).
			p.Comm = truncate(strings.TrimSpace(p.Comm), maxCommChars)
			procs = append(procs, p)
		}
		sort.SliceStable(procs, func(a, b int) bool { return val(procs[a].RSS) > val(procs[b].RSS) })
		s.Processes = compactJSON(procs)
	}
	return s, true, nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func val(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// tokens keeps the well-formed, distinct, lowercase tokens of in, at most n.
func tokens(in []string, n int) []string {
	out := make([]string, 0, min(len(in), n))
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if !tokenRE.MatchString(t) || seen[t] || len(out) == n {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// compactJSON encodes v, or "" when it cannot (plain structs never fail).
func compactJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}
