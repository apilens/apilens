package ingest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The golden fixtures are the M7 contract shared with the SDK test suites.
func loadHeartbeatFixture(t *testing.T, name string) (Heartbeat, json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "resources", name))
	if err != nil {
		t.Fatal(err)
	}
	var hb Heartbeat
	if err := json.Unmarshal(raw, &hb); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	var part struct {
		Resources json.RawMessage `json:"resources"`
	}
	if err := json.Unmarshal(raw, &part); err != nil {
		t.Fatal(err)
	}
	return hb, part.Resources
}

func TestResourcesFixtureFull(t *testing.T) {
	hb, raw := loadHeartbeatFixture(t, "heartbeat_v1.json")
	if hb.UptimeS == nil || *hb.UptimeS != 3600.5 || hb.Final {
		t.Fatalf("uptime/final = %v %v", hb.UptimeS, hb.Final)
	}
	id := sanitizeIdentity(hb.Identity, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	if id.Platform != "k8s" || id.PodName == "" || id.Namespace != "shop" || id.ProcessStartTime == nil {
		t.Fatalf("identity = %+v", id)
	}
	s, ok, aerr := flattenResources(hb.Resources, raw)
	if aerr != nil || !ok {
		t.Fatalf("flatten: ok=%v err=%v", ok, aerr)
	}
	want := map[string]float64{
		"process.cpu.pct_of_limit.avg":      31,
		"process.memory.pss.last":           127926272,
		"container.memory.working_set.max":  432013312,
		"container.memory.limit":            536870912,
		"container.memory.oom_kill":         0,
		"container.cpu.throttled_ratio":     0.18,
		"python.gc.gen0.collections":        41,
		"python.gil_enabled":                1,
		"pools.used.last":                   3,
		"process.cpu.cores_used.max":        0.62,
		"container.memory.swap.avg":         0,
		"container.cpu.limit_cores":         1,
		"python.gc.gen2.pause_ms_max":       0,
		"process.threads.last":              8,
		"container.cpu.pct_of_limit.max":    99,
		"container.memory.current.min":      503316480,
		"process.fds.avg":                   32,
		"python.threads.avg":                6,
		"pools.pending.max":                 1,
		"container.cpu.throttled_us":        2400000,
		"process.memory.rss.avg":            203423744,
		"process.memory.uss.min":            94371840,
		"container.memory.anon.last":        406847488,
		"container.memory.file.avg":         113246208,
		"container.cpu.cores_used.avg":      0.82,
		"python.gc.gen1.collected":          210,
		"python.gc.gen0.pause_ms_sum":       6.2,
		"process.cpu.pct_of_limit.max":      62,
		"python.gc.gen1.uncollectable":      0,
		"process.memory.rss.max":            205520896,
		"process.cpu.cores_used.min":        0.12,
		"process.cpu.pct_of_limit.min":      12,
		"process.cpu.pct_of_limit.last":     28,
		"process.cpu.cores_used.avg":        0.31,
		"process.cpu.cores_used.last":       0.28,
		"container.memory.working_set.avg":  425721856,
		"container.memory.working_set.min":  419430400,
		"container.memory.working_set.last": 432013312,
		"container.memory.current.max":      528482304,
		"container.memory.current.avg":      515899392,
		"container.memory.current.last":     528482304,
		"container.cpu.cores_used.min":      0.4,
		"container.cpu.cores_used.max":      0.99,
		"container.cpu.cores_used.last":     0.75,
		"container.cpu.pct_of_limit.min":    40,
		"container.cpu.pct_of_limit.avg":    82,
		"container.cpu.pct_of_limit.last":   75,
		"python.gc.gen0.collected":          1830,
		"python.gc.gen0.uncollectable":      0,
		"python.gc.gen0.pause_ms_max":       0.9,
		"python.gc.gen1.collections":        3,
		"python.gc.gen1.pause_ms_sum":       2.1,
		"python.gc.gen1.pause_ms_max":       1.1,
		"python.gc.gen2.collections":        0,
		"python.gc.gen2.collected":          0,
		"python.gc.gen2.uncollectable":      0,
		"python.gc.gen2.pause_ms_sum":       0,
	}
	for k, v := range want {
		if got, ok := s.Metrics[k]; !ok || got != v {
			t.Errorf("%s = %v (present %v), want %v", k, got, ok, v)
		}
	}
	if s.LimitSource != "cgroup_v2" || s.ContainerID == "" || s.Samples != 4 || s.WindowS != 60 {
		t.Fatalf("sample = %+v", s)
	}
	if !strings.Contains(s.Processes, `"comm":"gunicorn"`) || !strings.Contains(s.Pools, `"kind":"sqlalchemy"`) {
		t.Fatalf("lists = %s / %s", s.Processes, s.Pools)
	}
	// Processes are ordered by RSS, largest first.
	if !strings.HasPrefix(s.Processes, `[{"pid":4242`) {
		t.Fatalf("processes not sorted by rss: %s", s.Processes)
	}
}

func TestResourcesFixtureMinimalKeepsNulls(t *testing.T) {
	hb, raw := loadHeartbeatFixture(t, "heartbeat_v1_minimal.json")
	s, ok, aerr := flattenResources(hb.Resources, raw)
	if aerr != nil || !ok {
		t.Fatalf("flatten: ok=%v err=%v", ok, aerr)
	}
	for _, k := range []string{"process.memory.pss.avg", "process.threads.avg", "node.external.avg", "container.memory.limit", "container.cpu.cores_used.avg"} {
		if v, present := s.Metrics[k]; present {
			t.Errorf("%s present (%v); a null must stay absent, never 0", k, v)
		}
	}
	if s.Metrics["node.event_loop_delay_ms.p99"] != 14.6 || s.Metrics["node.gc.count"] != 7 {
		t.Fatalf("node metrics = %v", s.Metrics)
	}
	if s.ContainerID != "" || s.Pools != "" || s.Processes != "" {
		t.Fatalf("container/lists should be empty: %+v", s)
	}
	id := sanitizeIdentity(hb.Identity, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	if !id.HostnameGuess || id.Platform != "bare" || id.ContainerID != "" {
		t.Fatalf("identity = %+v", id)
	}
}

func TestFlattenResourcesDropsBadValues(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	r := &Resources{
		V:           1,
		LimitSource: "made-up",
		Process: &ProcessResources{CPU: &CPUUsage{
			CoresUsed:  &Gauge{Avg: f(3.5), Min: f(-1)},
			PctOfLimit: &Gauge{Avg: f(350)},
		}},
		Container: &ContainerResources{Memory: &ContainerMemory{
			Limit: f(9223372036854771712), // cgroup v1 "no limit" sentinel
		}, CPU: &ContainerCPU{ThrottledRatio: f(1.7)}},
		Capabilities: []string{"process.cpu", "process.cpu", "Bad Token!", ""},
		Processes: []ResourceProcess{
			{PID: -1, Comm: "x"},
			{PID: 7, Comm: "a-very-long-process-name"},
		},
	}
	s, ok, aerr := flattenResources(r, []byte(`{}`))
	if aerr != nil || !ok {
		t.Fatal(ok, aerr)
	}
	if s.Metrics["process.cpu.cores_used.avg"] != 3.5 {
		t.Errorf("cores_used is absolute and never clamped")
	}
	if _, present := s.Metrics["process.cpu.cores_used.min"]; present {
		t.Errorf("negative value kept")
	}
	if s.Metrics["process.cpu.pct_of_limit.avg"] != 100 {
		t.Errorf("pct_of_limit not clamped to 100: %v", s.Metrics["process.cpu.pct_of_limit.avg"])
	}
	if _, present := s.Metrics["container.memory.limit"]; present {
		t.Errorf("no-limit sentinel stored as a limit")
	}
	if s.Metrics["container.cpu.throttled_ratio"] != 1 {
		t.Errorf("throttled_ratio not clamped to 1")
	}
	if s.LimitSource != "" {
		t.Errorf("unknown limit_source kept: %q", s.LimitSource)
	}
	if len(s.Capabilities) != 1 || s.Capabilities[0] != "process.cpu" {
		t.Errorf("capabilities = %v", s.Capabilities)
	}
	if s.Processes != `[{"pid":7,"comm":"a-very-long-pro"}]` {
		t.Errorf("processes = %s", s.Processes)
	}
}

func TestFlattenResourcesVersionAndSize(t *testing.T) {
	if _, ok, aerr := flattenResources(nil, nil); ok || aerr != nil {
		t.Fatal("nil block must be a no-op")
	}
	if _, ok, aerr := flattenResources(&Resources{V: 2}, []byte(`{"v":2}`)); ok || aerr != nil {
		t.Fatal("unknown version must be ignored, not rejected")
	}
	big := []byte(`{"v":1,"flags":["` + strings.Repeat("x", maxResourcesSize) + `"]}`)
	if _, _, aerr := flattenResources(&Resources{V: 1}, big); aerr == nil {
		t.Fatal("oversize block accepted")
	}
}

func TestSanitizeIdentity(t *testing.T) {
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	future := now.Add(time.Hour)
	id := sanitizeIdentity(&Identity{Platform: "mainframe", PodName: "  web-1 ", ProcessStartTime: &future}, now)
	if id.Platform != "" || id.PodName != "web-1" || id.ProcessStartTime != nil {
		t.Fatalf("identity = %+v", id)
	}
	if got := sanitizeIdentity(nil, now); got != (Identity{}) {
		t.Fatalf("nil identity = %+v", got)
	}
}
