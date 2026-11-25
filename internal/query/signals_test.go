package query

import (
	"math"
	"strings"
	"testing"
	"time"
)

// series builds one point every step over span from f(hours since start).
func series(span, step time.Duration, f func(h float64) float64) []seriesPoint {
	t0 := time.Date(2026, 11, 25, 0, 0, 0, 0, time.UTC)
	var out []seriesPoint
	for d := time.Duration(0); d <= span; d += step {
		out = append(out, seriesPoint{t: t0.Add(d), v: f(d.Hours())})
	}
	return out
}

func TestLeakSignal(t *testing.T) {
	const base = 200 * mib
	limit := float64(512 * mib)

	// Flat: no leak, whatever the fit.
	if s := leakSignal("mem_rss", series(6*time.Hour, 5*time.Minute, func(float64) float64 { return base }), &limit); s != nil {
		t.Errorf("flat = %+v", s)
	}
	// Flat with jitter: R² is low.
	jitter := series(6*time.Hour, 5*time.Minute, func(h float64) float64 { return base + 3*mib*math.Sin(h*7) })
	if s := leakSignal("mem_rss", jitter, &limit); s != nil {
		t.Errorf("jitter = %+v", s)
	}
	// Sawtooth GC: the heap climbs 40 MB and is collected every 30 min.
	saw := series(6*time.Hour, 5*time.Minute, func(h float64) float64 { return base + 40*mib*math.Mod(h, 0.5)/0.5 })
	if s := leakSignal("heap_used", saw, nil); s != nil {
		t.Errorf("sawtooth = %+v", s)
	}
	// Steady leak of 10 MB/h with a little noise.
	leak := series(6*time.Hour, 5*time.Minute, func(h float64) float64 { return base + 10*mib*h + mib*math.Sin(h*11) })
	s := leakSignal("mem_rss", leak, &limit)
	if s == nil || s.Kind != "leak" || s.Metric != "mem_rss" || math.Abs(s.Value-10) > 0.5 {
		t.Fatalf("leak = %+v", s)
	}
	// 200 MB + 60 MB at the end, 252 MB to go at 10 MB/h: about 25 h.
	if !strings.Contains(s.Detail, "MB/h") || !strings.Contains(s.Detail, "512 MB limit in about 25") {
		t.Errorf("detail = %q", s.Detail)
	}
	if s := leakSignal("mem_rss", leak, nil); s == nil || strings.Contains(s.Detail, "limit") {
		t.Errorf("no limit = %+v", s)
	}
	// Less than 2 h of data: no signal even for a clear leak.
	short := series(100*time.Minute, time.Minute, func(h float64) float64 { return base + 50*mib*h })
	if s := leakSignal("mem_rss", short, &limit); s != nil {
		t.Errorf("short = %+v", s)
	}
	// Shrinking memory is never a leak.
	down := series(6*time.Hour, 5*time.Minute, func(h float64) float64 { return base - 10*mib*h })
	if s := leakSignal("mem_rss", down, &limit); s != nil {
		t.Errorf("shrinking = %+v", s)
	}
	// Too few points.
	if s := leakSignal("mem_rss", leak[:3], &limit); s != nil {
		t.Errorf("3 points = %+v", s)
	}
}

func TestLinearFit(t *testing.T) {
	pts := series(2*time.Hour, time.Hour, func(h float64) float64 { return 10 + 3600*h })
	slope, last, r2, ok := linearFit(pts)
	if !ok || math.Abs(slope-1) > 1e-9 || math.Abs(last-7210) > 1e-6 || math.Abs(r2-1) > 1e-9 {
		t.Errorf("fit = %v %v %v %v", slope, last, r2, ok)
	}
	if _, _, _, ok := linearFit(pts[:1]); ok {
		t.Error("one point fits")
	}
}

func TestNoisyInstances(t *testing.T) {
	k := func(env, id string) instanceKey { return instanceKey{env, id} }
	// Two instances: never noisy, however far apart.
	if got := noisyInstances(map[instanceKey]float64{k("p", "a"): 10, k("p", "b"): 95}, noisyMinCPUPoints); len(got) != 0 {
		t.Errorf("2 instances = %v", got)
	}
	vals := map[instanceKey]float64{
		k("p", "a"): 20, k("p", "b"): 22, k("p", "c"): 25, k("p", "hot"): 80,
		// 1.5× the median but only 9 points above: not noisy.
		k("s", "a"): 18, k("s", "b"): 18, k("s", "c"): 27,
	}
	got := noisyInstances(vals, noisyMinCPUPoints)
	if len(got) != 1 {
		t.Fatalf("noisy = %v", got)
	}
	ref, ok := got[k("p", "hot")]
	if !ok || ref[0] != 23.5 || ref[1] != 4 {
		t.Errorf("hot = %v", ref)
	}
	sig := noisySignal("cpu_pct", 80, ref[0], int(ref[1]))
	if sig.Kind != "noisy" || sig.Value != 80 || sig.Detail != "CPU 80% over 15 min vs a median of 23.5% across 4 instances" {
		t.Errorf("signal = %+v", sig)
	}
	// p95: 1.5× and 100 ms.
	p95 := map[instanceKey]float64{k("p", "a"): 100, k("p", "b"): 120, k("p", "c"): 400, k("p", "d"): 190}
	if got := noisyInstances(p95, noisyMinP95Ms); len(got) != 1 || got[k("p", "c")][0] != 155 {
		t.Errorf("p95 noisy = %v", got)
	}
}

func TestInstanceResources(t *testing.T) {
	if r, _ := instanceResources(nil); r != nil {
		t.Errorf("no snapshot = %+v", r)
	}
	raw := []byte(`{"limit_source":"cgroup_v2","metrics":{
		"process.cpu.pct_of_limit.avg":40,"process.cpu.cores_used.avg":0.4,"container.cpu.limit_cores":1,
		"container.memory.working_set.last":268435456,"container.memory.limit":536870912,"process.memory.rss.last":100,
		"container.cpu.throttled_ratio":0.25,"python.gc.gen0.pause_ms_sum":1.5,"python.gc.gen2.pause_ms_sum":3}}`)
	r, _ := instanceResources(raw)
	if r == nil || r.LimitSource != "cgroup_v2" || *r.CPUPct != 40 || *r.CPUCores != 0.4 || *r.CPULimitCores != 1 ||
		*r.MemWorkingSet != 268435456 || *r.MemRSS != 100 || r.MemPSS != nil || *r.MemPct != 50 || *r.ThrottledRatio != 0.25 {
		t.Fatalf("resources = %+v", r)
	}
	if r.Runtime.GCPauseMs == nil || *r.Runtime.GCPauseMs != 4.5 || r.Runtime.HeapUsed != nil || r.Runtime.EventLoopP99 != nil {
		t.Errorf("runtime = %+v", r.Runtime)
	}
	// No limit: no percent.
	if r, _ := instanceResources([]byte(`{"metrics":{"process.memory.rss.last":100}}`)); r == nil || r.MemPct != nil || r.CPUPct != nil {
		t.Errorf("no limit = %+v", r)
	}
}

func TestStatusCursor(t *testing.T) {
	c := statusCursor{SeenAt: time.Date(2026, 11, 25, 1, 2, 3, 456789000, time.UTC), Environment: "production", InstanceID: "w-1"}
	got, err := decodeStatusCursor(c.encode())
	if err != nil || got == nil || !got.SeenAt.Equal(c.SeenAt) || got.Environment != c.Environment || got.InstanceID != c.InstanceID {
		t.Errorf("round trip = %+v, %v", got, err)
	}
	if _, err := decodeStatusCursor("not-a-cursor"); err == nil {
		t.Error("bad cursor accepted")
	}
	if got, err := decodeStatusCursor(""); got != nil || err != nil {
		t.Errorf("empty = %+v, %v", got, err)
	}
}
