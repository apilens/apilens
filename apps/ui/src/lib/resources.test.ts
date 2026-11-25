import { describe, expect, it } from "vitest";
import type { AppInstance, AppStatus, CapturePolicy, InstanceResources } from "./identity";
import {
  appTabHref,
  bucketOf,
  chartMarkers,
  dominantRuntime,
  filterInstances,
  formatResource,
  formatUptime,
  instanceBadges,
  limitHint,
  memoryCell,
  nextInstanceSort,
  niceTop,
  parseAppTab,
  parseResourcesQuery,
  percentile,
  resourceTiles,
  resourcesEmpty,
  resourcesHref,
  runtimeKind,
  sortInstances,
  splitEnded,
  timeX,
  trafficOverlay,
  unitTop,
} from "./resources";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MiB = 1024 * 1024;

const res = (r: Partial<InstanceResources> = {}): InstanceResources => ({
  limit_source: "cgroup_v2",
  cpu_pct: 20,
  cpu_cores: 0.2,
  cpu_limit_cores: 1,
  mem_working_set: 400 * MiB,
  mem_rss: 300 * MiB,
  mem_pss: 250 * MiB,
  mem_limit: 1024 * MiB,
  mem_pct: 39,
  throttled_ratio: 0.01,
  runtime: null,
  ...r,
});

const inst = (id: string, over: Partial<AppInstance> = {}): AppInstance => ({
  instance_id: id,
  environment: "production",
  sdk_name: "apilenss",
  sdk_version: "0.5.0",
  sdk_latest_version: "0.5.0",
  sdk_outdated: false,
  runtime: "python 3.12.7",
  release: "",
  commit: "",
  first_seen_at: "2026-11-25T07:00:00Z",
  last_seen_at: "2026-11-25T11:59:50Z",
  platform: "k8s",
  pod_name: `pod-${id}`,
  resources: res(),
  ended_at: null,
  ended_reason: "",
  requests: { rpm: 100, p95_ms: 120, error_pct: 0.5 },
  uptime_s: 3600,
  ...over,
});

describe("app tabs", () => {
  it("opens the Resources tab only from ?tab=resources", () => {
    expect(parseAppTab({ tab: "resources" })).toBe("resources");
    expect(parseAppTab({ tab: ["resources", "x"] })).toBe("resources");
    expect(parseAppTab({ tab: "nope" })).toBe("overview");
    expect(parseAppTab({})).toBe("overview");
  });

  it("links the Overview to the plain app URL", () => {
    expect(appTabHref("shop", "checkout api", "overview")).toBe("/shop/apps/checkout%20api");
    expect(appTabHref("shop", "checkout", "resources")).toBe("/shop/apps/checkout?tab=resources");
  });
});

describe("the Resources tab's URL", () => {
  it("parses the scope with defaults for anything unknown", () => {
    expect(parseResourcesQuery({})).toEqual({ range: "6h", env: "", instance: "", container: "", cpu: "pct", mem: "working_set", traffic: true });
    expect(parseResourcesQuery({ range: "24h", env: " prod ", instance: "w1", cpu: "cores", mem: "pss", traffic: "off" })).toEqual({
      range: "24h",
      env: "prod",
      instance: "w1",
      container: "",
      cpu: "cores",
      mem: "pss",
      traffic: false,
    });
    expect(parseResourcesQuery({ range: "90d", cpu: "x", mem: "y" })).toMatchObject({ range: "6h", cpu: "pct", mem: "working_set" });
  });

  it("keeps defaults out of the URL and round-trips the rest", () => {
    expect(resourcesHref("shop", "checkout")).toBe("/shop/apps/checkout?tab=resources");
    const href = resourcesHref("shop", "checkout", { range: "1h", env: "staging", instance: "w 1", cpu: "cores", mem: "rss", traffic: false });
    expect(href).toBe("/shop/apps/checkout?tab=resources&range=1h&env=staging&instance=w+1&cpu=cores&mem=rss&traffic=off");
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseResourcesQuery(params)).toMatchObject({ range: "1h", env: "staging", instance: "w 1", cpu: "cores", mem: "rss", traffic: false });
  });
});

describe("values and axes", () => {
  it("rounds axis tops on a fine ladder", () => {
    expect(niceTop(0)).toBe(1);
    expect(niceTop(1)).toBe(1);
    expect(niceTop(1.1)).toBe(1.2);
    expect(niceTop(45)).toBe(50);
    expect(niceTop(62)).toBe(80);
    expect(niceTop(845)).toBe(1000);
  });

  it("caps percent at 100 and ratios at 1, and leaves room above a limit", () => {
    expect(unitTop("percent", [12, null, 38])).toBe(40);
    expect(unitTop("percent", [97])).toBe(100);
    expect(unitTop("ratio", [0.03])).toBe(0.03);
    expect(unitTop("ratio", [null])).toBe(0.01);
    // 1 GiB limit: the top is above it, in GB.
    expect(unitTop("bytes", [400 * MiB], 1024 * MiB)).toBe(1.2 * 1024 * MiB);
    expect(unitTop("bytes", [300 * MiB])).toBe(300 * MiB);
    expect(unitTop("cores", [0.3], 1)).toBe(1.2);
  });

  it("formats each unit, and a missing value as a dash, never 0", () => {
    expect(formatResource("percent", 42)).toBe("42.0%");
    expect(formatResource("percent", 0)).toBe("0%");
    expect(formatResource("ratio", 0.125)).toBe("12.5%");
    expect(formatResource("cores", 0.35)).toBe("0.35 cores");
    expect(formatResource("cores", 1)).toBe("1.00 core");
    expect(formatResource("bytes", 512 * MiB)).toBe("512 MB");
    expect(formatResource("ms", 18)).toBe("18 ms");
    expect(formatResource("count", 12)).toBe("12");
    expect(formatResource("percent", null)).toBe("—");
    expect(formatResource("bytes", undefined)).toBe("—");
  });

  it("finds the bucket and x of a time", () => {
    const points = [{ t: "2026-11-25T10:00:00Z" }, { t: "2026-11-25T10:05:00Z" }, { t: "2026-11-25T10:10:00Z" }];
    expect(bucketOf("2026-11-25T10:06:00Z", points, 300)).toBe(1);
    expect(bucketOf("2026-11-25T09:59:00Z", points, 300)).toBeNull();
    expect(bucketOf("2026-11-25T10:15:00Z", points, 300)).toBeNull();
    expect(timeX("2026-11-25T10:07:30Z", points, 300, 300)).toBe(150);
    expect(timeX("2026-11-25T11:00:00Z", points, 300, 300)).toBeNull();
  });

  it("lays traffic onto the resource buckets as requests per minute, gaps as null", () => {
    const points = [{ t: "2026-11-25T10:00:00Z" }, { t: "2026-11-25T10:15:00Z" }, { t: "2026-11-25T11:00:00Z" }];
    const traffic = { range: "6h", bucket_seconds: 1800, points: [{ ts: "2026-11-25T10:00:00Z", requests: 3000, client_errors: 0, server_errors: 0, p95_ms: 0 }] };
    expect(trafficOverlay(points, traffic)).toEqual([100, 100, null]);
    expect(trafficOverlay(points, null)).toEqual([null, null, null]);
  });

  it("marks restarts, OOM kills and deploys oldest first", () => {
    const m = chartMarkers(
      [
        { kind: "oom", at: "2026-11-25T09:00:00Z", instance_id: "b1", container_id: "c", pod_name: "pod-b", details: {} },
        { kind: "restart", at: "2026-11-25T11:00:00Z", instance_id: "a1", container_id: "", pod_name: "", details: null },
      ],
      [{ id: "d", deployed_at: "2026-11-25T08:00:00Z", release: "2026.11.25-2", commit: "3f9a2c1d8e" } as never],
    );
    expect(m.map((x) => [x.kind, x.label])).toEqual([
      ["deploy", "Deploy 2026.11.25-2"],
      ["oom", "OOMKilled: pod-b"],
      ["restart", "Restarted: a1"],
    ]);
  });
});

describe("instances", () => {
  it("badges how an instance ended, its signals, serverless and an old SDK", () => {
    expect(instanceBadges(inst("a", { ended_at: "2026-11-25T09:00:00Z", ended_reason: "oom" })).map((b) => b.label)).toEqual(["OOMKilled"]);
    expect(instanceBadges(inst("a", { ended_at: "2026-11-25T09:00:00Z", ended_reason: "restart" })).map((b) => b.label)).toEqual(["Restarted"]);
    expect(
      instanceBadges(
        inst("a", {
          signals: [
            { kind: "leak", metric: "mem_rss", value: 40.3, detail: "" },
            { kind: "noisy", metric: "cpu_pct", value: 2.3, detail: "2.3× the median" },
          ],
        }),
      ).map((b) => [b.label, b.tone]),
    ).toEqual([
      ["Leak +40 MB/h", "warn"],
      ["Noisy", "warn"],
    ]);
    expect(instanceBadges(inst("a", { platform: "lambda" })).map((b) => b.label)).toEqual(["Serverless"]);
    expect(instanceBadges(inst("a", { resources: null })).map((b) => b.label)).toEqual(["No resources"]);
    expect(instanceBadges(inst("a"))).toEqual([]);
  });

  it("shows memory as the share of the limit, or bytes without one, and a dash for an old SDK", () => {
    expect(memoryCell(inst("a"))).toEqual({ main: "39.0%", sub: "400 MB" });
    expect(memoryCell(inst("a", { resources: res({ mem_pct: null, mem_limit: null }) }))).toEqual({ main: "400 MB", sub: "no limit" });
    expect(memoryCell(inst("a", { resources: null }))).toEqual({ main: "—", sub: "" });
  });

  it("formats uptime", () => {
    expect(formatUptime(48)).toBe("48 s");
    expect(formatUptime(12 * 60)).toBe("12 min");
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
    expect(formatUptime(3 * 3600)).toBe("3 h");
    expect(formatUptime(2 * 86400 + 4 * 3600)).toBe("2 d 4 h");
    expect(formatUptime(null)).toBe("—");
  });

  it("splits off instances that ended in the last 24 hours and drops older ones", () => {
    const { live, ended } = splitEnded(
      [inst("a"), inst("b", { ended_at: "2026-11-25T09:00:00Z", ended_reason: "oom" }), inst("c", { ended_at: "2026-11-23T09:00:00Z", ended_reason: "graceful" })],
      NOW,
    );
    expect(live.map((i) => i.instance_id)).toEqual(["a"]);
    expect(ended.map((i) => i.instance_id)).toEqual(["b"]);
  });

  it("filters by environment", () => {
    const all = [inst("a"), inst("b", { environment: "staging" })];
    expect(filterInstances(all, "staging").map((i) => i.instance_id)).toEqual(["b"]);
    expect(filterInstances(all, "")).toHaveLength(2);
  });

  it("sorts by each column, unmeasured values last either way", () => {
    const all = [
      inst("a", { resources: res({ cpu_pct: 20 }), requests: { rpm: 50, p95_ms: 300, error_pct: 1 } }),
      inst("b", { resources: res({ cpu_pct: 65 }), requests: { rpm: 200, p95_ms: 100, error_pct: 0 } }),
      inst("old", { resources: null, requests: null }),
      inst("fn", { platform: "lambda", resources: res({ cpu_pct: 90 }) }),
    ];
    const ids = (key: Parameters<typeof sortInstances>[1]["key"], dir: "asc" | "desc") => sortInstances(all, { key, dir }).map((i) => i.instance_id);
    // Serverless CPU is hidden, so it sorts with the unmeasured.
    expect(ids("cpu", "desc")).toEqual(["b", "a", "fn", "old"]);
    expect(ids("cpu", "asc")).toEqual(["a", "b", "fn", "old"]);
    expect(ids("p95", "desc")).toEqual(["a", "fn", "b", "old"]);
    expect(ids("rpm", "asc")[3]).toBe("old");
    expect(ids("instance", "asc")).toEqual(["a", "b", "fn", "old"]);
  });

  it("flips the same column and starts numbers biggest first", () => {
    expect(nextInstanceSort({ key: "cpu", dir: "desc" }, "cpu")).toEqual({ key: "cpu", dir: "asc" });
    expect(nextInstanceSort({ key: "cpu", dir: "asc" }, "mem")).toEqual({ key: "mem", dir: "desc" });
    expect(nextInstanceSort({ key: "cpu", dir: "asc" }, "instance")).toEqual({ key: "instance", dir: "asc" });
  });

  it("says where the limit came from, leaving serverless out", () => {
    expect(limitHint([inst("a")])).toBe("Limit from cgroup v2");
    expect(limitHint([inst("a", { resources: res({ limit_source: "none" }) })])).toBe("No limit set: % of host cores");
    expect(limitHint([inst("a"), inst("b", { resources: res({ limit_source: "ecs" }) })])).toBe("Limits from cgroup v2 and the ECS task");
    expect(limitHint([inst("a"), inst("fn", { platform: "lambda", resources: res({ limit_source: "none" }) })])).toBe("Limit from cgroup v2");
    expect(limitHint([inst("old", { resources: null })])).toBeNull();
  });
});

describe("empty states", () => {
  const status = (instances: AppInstance[]): AppStatus => ({ instances }) as AppStatus;
  const policy = (enabled: boolean) => ({ resources: { enabled, min_interval_s: 15, disabled_collectors: [] } }) as unknown as CapturePolicy;

  it("tells sampling off, old SDKs, no instance and no samples yet apart", () => {
    expect(resourcesEmpty(status([inst("a")]), policy(false), true)).toBe("disabled");
    expect(resourcesEmpty(status([inst("a", { resources: null })]), policy(true), false)).toBe("old_sdk");
    expect(resourcesEmpty(status([]), null, false)).toBe("no_instances");
    expect(resourcesEmpty(status([inst("a")]), null, false)).toBe("no_data");
    expect(resourcesEmpty(status([inst("a")]), null, true)).toBeNull();
    // One instance on a new SDK is enough to chart.
    expect(resourcesEmpty(status([inst("a", { resources: null }), inst("b")]), null, false)).toBe("no_data");
  });
});

describe("runtime", () => {
  it("reads the runtime from the instance's runtime string", () => {
    expect(runtimeKind("python 3.13.1")).toBe("python");
    expect(runtimeKind("node 22.11.0")).toBe("node");
    expect(runtimeKind("java 21.0.5")).toBe("java");
    expect(runtimeKind("go 1.23")).toBeNull();
    expect(dominantRuntime([inst("a", { runtime: "node 22" }), inst("b", { runtime: "node 22" }), inst("c")])).toBe("node");
    expect(dominantRuntime([])).toBeNull();
  });
});

describe("overview tiles", () => {
  it("takes the p95 over the live instances' minutes and warns above 80% of the limit", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.95)).toBeNull();
    const t = resourceTiles({
      instances: [
        inst("a", { spark: { cpu_pct: [80, 90, null], mem: [900 * MiB, 950 * MiB, null] } }),
        inst("b", { spark: { cpu_pct: [10, 20, 30], mem: [100 * MiB, 100 * MiB, 100 * MiB] } }),
        inst("fn", { platform: "lambda", spark: { cpu_pct: [null, null, null], mem: [64 * MiB, null, null] }, resources: res({ mem_limit: 512 * MiB }) }),
        inst("gone", { ended_at: "2026-11-25T09:00:00Z", spark: { cpu_pct: [100], mem: [1024 * MiB] } }),
      ],
    } as AppStatus);
    expect(t.cpu?.value).toBe("90.0%");
    expect(t.cpu?.warn).toBe(true);
    expect(t.cpu?.sub).toBe("p95 of 2 instances, of the limit");
    expect(t.cpu?.spark).toEqual([45, 55, 30]);
    expect(t.mem?.warn).toBe(true);
    expect(t.mem?.value).toBe("92.8%");
  });

  it("is hidden without data, and shows bytes without a limit", () => {
    expect(resourceTiles(null)).toEqual({ cpu: null, mem: null });
    expect(resourceTiles({ instances: [inst("old", { resources: null })] } as AppStatus)).toEqual({ cpu: null, mem: null });
    const t = resourceTiles({ instances: [inst("a", { resources: res({ mem_limit: null }), spark: { cpu_pct: [10], mem: [300 * MiB] } })] } as AppStatus);
    expect(t.mem).toMatchObject({ value: "300 MB", warn: false, share: null });
  });
});
