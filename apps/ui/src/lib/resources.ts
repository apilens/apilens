// Runtime resources on an app's page (M7, #1080 D15): the Overview | Resources tabs, the Resources
// tab's scope in the URL, the CPU, memory and runtime charts, the instances table (columns,
// badges, sorting) and the Overview's resource tiles. Pure helpers, unit-tested in resources.test.ts.
import { formatBytes } from "./endpoint-detail";
import { formatPercent } from "./format";
import type {
  AppInstance,
  AppStatus,
  CapturePolicy,
  DeployChange,
  InstanceEvent,
  InstanceEventKind,
  QueryRange,
  ResourceMetric,
  ResourcePoint,
  ResourceUnit,
  TrafficTimeseries,
} from "./identity";
import { formatCount } from "./consumers";
import { formatLatency } from "./traffic";

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

// Tabs ------------------------------------------------------------------------------------------

export type AppTab = "overview" | "resources";
export const APP_TABS: readonly { id: AppTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "resources", label: "Resources" },
];

/** The ids that tie the tabs to their panel. */
export const appTabId = (tab: AppTab) => `ap-tab-${tab}`;
export const APP_TABPANEL_ID = "ap-tabpanel";

/** `?tab=resources` opens the Resources tab; anything else (or nothing) is the Overview. */
export function parseAppTab(params: SearchParams): AppTab {
  return one(params.tab) === "resources" ? "resources" : "overview";
}

/** The page for a tab: the Overview is the app's plain URL, so old links keep working. */
export function appTabHref(project: string, app: string, tab: AppTab): string {
  const base = `/${encodeURIComponent(project)}/apps/${encodeURIComponent(app)}`;
  return tab === "overview" ? base : `${base}?tab=${tab}`;
}

// The Resources tab's scope ---------------------------------------------------------------------

export type CpuView = "pct" | "cores";
export type MemView = "working_set" | "rss" | "pss";

export interface ResourcesState {
  range: QueryRange;
  /** Empty means every environment. */
  env: string;
  /** One instance, or empty for all. */
  instance: string;
  /** One container, or empty for all. */
  container: string;
  cpu: CpuView;
  mem: MemView;
  /** Requests per minute drawn over the charts on a second axis. */
  traffic: boolean;
}

export const RESOURCE_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const RESOURCES_DEFAULT: ResourcesState = { range: "6h", env: "", instance: "", container: "", cpu: "pct", mem: "working_set", traffic: true };

export function parseResourcesQuery(params: SearchParams): ResourcesState {
  const range = one(params.range) as QueryRange;
  const cpu = one(params.cpu);
  const mem = one(params.mem);
  return {
    range: RESOURCE_RANGES.includes(range) ? range : RESOURCES_DEFAULT.range,
    env: one(params.env).trim(),
    instance: one(params.instance).trim(),
    container: one(params.container).trim(),
    cpu: cpu === "cores" ? "cores" : "pct",
    mem: mem === "rss" || mem === "pss" ? mem : "working_set",
    traffic: one(params.traffic) !== "off",
  };
}

/** The Resources tab with `q` over the defaults; default values stay out of the URL. */
export function resourcesHref(project: string, app: string, q: Partial<ResourcesState> = {}): string {
  const s = { ...RESOURCES_DEFAULT, ...q };
  const p = new URLSearchParams({ tab: "resources" });
  if (s.range !== RESOURCES_DEFAULT.range) p.set("range", s.range);
  if (s.env) p.set("env", s.env);
  if (s.instance) p.set("instance", s.instance);
  if (s.container) p.set("container", s.container);
  if (s.cpu !== "pct") p.set("cpu", s.cpu);
  if (s.mem !== "working_set") p.set("mem", s.mem);
  if (!s.traffic) p.set("traffic", "off");
  return `/${encodeURIComponent(project)}/apps/${encodeURIComponent(app)}?${p.toString()}`;
}

export const CPU_METRIC: Record<CpuView, ResourceMetric> = { pct: "cpu_pct", cores: "cpu_cores" };
export const MEM_METRIC: Record<MemView, ResourceMetric> = { working_set: "mem_working_set", rss: "mem_rss", pss: "mem_pss" };
export const MEM_VIEW_LABEL: Record<MemView, string> = { working_set: "Container working set", rss: "Process RSS", pss: "Process PSS" };

// Values and axes -------------------------------------------------------------------------------

/** A round axis top at or above `n`, on a finer ladder than niceMax (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k). */
export function niceTop(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const k = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * k >= n - 1e-9 * k) return m * k;
  return 10 * k;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * The axis top of a series: rounded above its highest max (and above the limit when one is drawn,
 * with room so the limit line is not the frame). Percent never goes past 100, ratios past 1; bytes
 * round in MB or GB so the label reads round.
 */
export function unitTop(unit: ResourceUnit, values: readonly (number | null)[], limit: number | null = null): number {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const peak = Math.max(0, ...known);
  const base = limit !== null && limit > 0 ? Math.max(peak, limit * 1.1) : peak;
  switch (unit) {
    case "percent":
      return Math.min(100, niceTop(Math.max(base, 1)));
    case "ratio":
      return Math.min(1, niceTop(Math.max(base, 0.01)));
    case "bytes": {
      const scale = base >= GiB ? GiB : MiB;
      return niceTop(Math.max(base, MiB) / scale) * scale;
    }
    default:
      return niceTop(Math.max(base, unit === "cores" ? 0.1 : 1));
  }
}

/** One value as its unit reads: `42.0%`, `0.35 cores`, `512 MB`, `18 ms`, `12`; `—` when not measured. */
export function formatResource(unit: ResourceUnit, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "percent":
      return v === 0 ? "0%" : formatPercent(v / 100);
    case "ratio":
      return v === 0 ? "0%" : formatPercent(v);
    case "cores":
      return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${v === 1 ? "core" : "cores"}`;
    case "bytes":
      return formatBytes(v);
    case "ms":
      return formatLatency(v);
    default:
      return formatCount(v);
  }
}

/** The bucket a time falls in, or null outside the series. */
export function bucketOf(at: string, points: readonly Pick<ResourcePoint, "t">[], bucketSeconds: number): number | null {
  const first = points[0];
  const t = Date.parse(at);
  if (!first || Number.isNaN(t) || !(bucketSeconds > 0)) return null;
  const i = Math.floor((t - Date.parse(first.t)) / (bucketSeconds * 1000));
  return i >= 0 && i < points.length ? i : null;
}

/** The x of a time on a plot `width` wide with `points` buckets (linear in time; the bucket's centre at its middle). */
export function timeX(at: string, points: readonly Pick<ResourcePoint, "t">[], bucketSeconds: number, width: number): number | null {
  const first = points[0];
  const t = Date.parse(at);
  if (!first || Number.isNaN(t) || !(bucketSeconds > 0) || points.length === 0) return null;
  const span = points.length * bucketSeconds * 1000;
  const f = (t - Date.parse(first.t)) / span;
  if (f < 0 || f > 1) return null;
  return f * width;
}

/**
 * Requests per minute in each resources bucket, from the traffic timeseries of the same scope: a
 * bucket takes the traffic bucket it starts in. Null where traffic has no bucket (a gap, not zero).
 */
export function trafficOverlay(points: readonly Pick<ResourcePoint, "t">[], traffic: TrafficTimeseries | null): (number | null)[] {
  const rows = traffic?.points ?? [];
  const tbs = traffic?.bucket_seconds ?? 0;
  if (rows.length === 0 || !(tbs > 0)) return points.map(() => null);
  const starts = rows.map((r) => Date.parse(r.ts));
  return points.map((p) => {
    const t = Date.parse(p.t);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (starts[i] <= t && t < starts[i] + tbs * 1000) return rows[i].requests / (tbs / 60);
    }
    return null;
  });
}

// Markers: restarts, OOM kills and deploys ------------------------------------------------------

export type MarkerKind = "oom" | "restart" | "deploy";

export const EVENT_LABEL: Record<InstanceEventKind, string> = {
  oom: "OOMKilled",
  oom_kill: "OOM kill in the container",
  suspected_oom: "Suspected OOM",
  restart: "Restarted",
};

export interface ChartMarker {
  kind: MarkerKind;
  at: string;
  /** What the tooltip says: `OOMKilled: checkout-api-7d9f8b-m8q2z`, `Deploy 2026.11.25-1`. */
  label: string;
}

/** The markers on the resources charts: every restart and OOM event, then every deploy, oldest first. */
export function chartMarkers(events: readonly InstanceEvent[] | null, deploys: readonly DeployChange[] | null): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const e of events ?? []) {
    const kind: MarkerKind = e.kind === "restart" ? "restart" : "oom";
    const who = e.pod_name || e.instance_id;
    out.push({ kind, at: e.at, label: `${EVENT_LABEL[e.kind] ?? e.kind}${who ? `: ${who}` : ""}` });
  }
  for (const d of deploys ?? []) {
    out.push({ kind: "deploy", at: d.deployed_at, label: `Deploy ${d.release || d.commit.slice(0, 7) || ""}`.trim() });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// Instances -------------------------------------------------------------------------------------

/** Platforms that only get CPU while handling a request (D13): CPU % would mislead, so it is hidden. */
const SERVERLESS = new Set(["lambda", "cloud_run"]);
export const isServerless = (i: Pick<AppInstance, "platform">) => SERVERLESS.has(i.platform ?? "");

export const PLATFORM_LABEL: Record<string, string> = {
  k8s: "Kubernetes",
  ecs: "Amazon ECS",
  cloud_run: "Cloud Run",
  app_engine: "App Engine",
  heroku: "Heroku",
  fly: "Fly.io",
  lambda: "AWS Lambda",
  vm: "Virtual machine",
  bare: "Bare metal",
};

export const LIMIT_HINT: Record<string, string> = {
  cgroup_v2: "Limit from cgroup v2",
  cgroup_v1: "Limit from cgroup v1",
  ecs: "Limit from the ECS task",
  vm: "Limit from the VM",
  host: "No limit set: % of host cores",
  none: "No limit set: % of host cores",
};

const LIMIT_SHORT: Record<string, string> = {
  cgroup_v2: "cgroup v2",
  cgroup_v1: "cgroup v1",
  ecs: "the ECS task",
  vm: "the VM",
  host: "none set (% of host cores)",
  none: "none set (% of host cores)",
};

/**
 * Where the instances' CPU and memory limits came from, as one hint: `Limit from cgroup v2`, or
 * `Limits from cgroup v2 and none set (% of host cores)` when they differ. Serverless instances are
 * left out (their CPU is hidden); null when no instance says.
 */
export function limitHint(instances: readonly AppInstance[]): string | null {
  const sources = [...new Set(instances.filter((i) => !isServerless(i)).map((i) => i.resources?.limit_source ?? "").filter(Boolean))];
  if (sources.length === 0) return null;
  if (sources.length === 1) return LIMIT_HINT[sources[0]] ?? null;
  const names = [...new Set(sources.map((s) => LIMIT_SHORT[s] ?? s))];
  return `Limits from ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type BadgeTone = "warn" | "error" | "info" | "muted";
export interface InstanceBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  title: string;
}

const ENDED: Record<string, { label: string; tone: BadgeTone; title: string }> = {
  oom: { label: "OOMKilled", tone: "error", title: "The container's OOM killer ended this process." },
  suspected_oom: { label: "Suspected OOM", tone: "error", title: "The process ended with its container at 90% or more of its memory limit." },
  restart: { label: "Restarted", tone: "warn", title: "The process ended and a new one took its place in the same container." },
  graceful: { label: "Stopped", tone: "muted", title: "The process sent its final heartbeat and shut down cleanly." },
};

/** The badges of an instance's row: how it ended, its signals (noisy, leak) and serverless. */
export function instanceBadges(i: AppInstance): InstanceBadge[] {
  const out: InstanceBadge[] = [];
  const ended = i.ended_reason ? ENDED[i.ended_reason] : undefined;
  if (ended) out.push({ key: `ended-${i.ended_reason}`, ...ended });
  for (const s of i.signals ?? []) {
    if (s.kind === "leak") {
      out.push({ key: `leak-${s.metric}`, label: `Leak +${formatCount(Math.round(s.value))} MB/h`, tone: "warn", title: s.detail || "Memory grows steadily." });
    } else if (s.kind === "noisy") {
      out.push({ key: `noisy-${s.metric}`, label: "Noisy", tone: "warn", title: s.detail || "This instance is an outlier against its peers." });
    }
  }
  if (isServerless(i)) out.push({ key: "serverless", label: "Serverless", tone: "info", title: "CPU only runs while a request is handled, so CPU % is hidden." });
  if (i.resources === null && !i.ended_reason) out.push({ key: "no-resources", label: "No resources", tone: "muted", title: "This SDK version does not report CPU and memory." });
  return out;
}

/** How long a process has run: `48 s`, `12 min`, `3 h 12 min`, `2 d 4 h`. */
export function formatUptime(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const d = Math.floor(h / 24);
  return `${d} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** Ended instances stay listed for 24 hours after they end, collapsed under the live ones. */
export const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The live instances and those that ended in the last 24 hours (older ones dropped). */
export function splitEnded(instances: readonly AppInstance[], now: number): { live: AppInstance[]; ended: AppInstance[] } {
  const live: AppInstance[] = [];
  const ended: AppInstance[] = [];
  for (const i of instances) {
    if (!i.ended_at) live.push(i);
    else if (now - Date.parse(i.ended_at) <= ENDED_WINDOW_MS) ended.push(i);
  }
  return { live, ended };
}

export type InstanceSortKey = "instance" | "cpu" | "mem" | "throttled" | "rpm" | "p95" | "errors" | "uptime" | "seen";
export type SortDir = "asc" | "desc";
export interface InstanceSort {
  key: InstanceSortKey;
  dir: SortDir;
}

/** Numbers sort biggest first on the first click (the outlier on top); names and ages A to Z. */
export const firstInstanceDir = (key: InstanceSortKey): SortDir => (key === "instance" ? "asc" : "desc");
export const INSTANCE_SORT_DEFAULT: InstanceSort = { key: "seen", dir: "desc" };

/** The value an instance sorts by; null when it was not measured (always sorted last). */
export function instanceSortValue(i: AppInstance, key: InstanceSortKey): number | string | null {
  const r = i.resources;
  switch (key) {
    case "instance":
      return (i.pod_name || i.hostname || i.instance_id).toLowerCase();
    case "cpu":
      return isServerless(i) ? null : (r?.cpu_pct ?? null);
    case "mem":
      return r?.mem_pct ?? r?.mem_working_set ?? r?.mem_rss ?? null;
    case "throttled":
      return r?.throttled_ratio ?? null;
    case "rpm":
      return i.requests?.rpm ?? null;
    case "p95":
      return i.requests ? i.requests.p95_ms : null;
    case "errors":
      return i.requests?.error_pct ?? null;
    case "uptime":
      return i.uptime_s ?? null;
    case "seen":
      return Date.parse(i.last_seen_at) || null;
  }
}

/** The instances sorted by `sort`; unmeasured values sort last either way, ties by id. */
export function sortInstances(instances: readonly AppInstance[], sort: InstanceSort): AppInstance[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...instances].sort((a, b) => {
    const x = instanceSortValue(a, sort.key);
    const y = instanceSortValue(b, sort.key);
    if (x === null && y === null) return a.instance_id.localeCompare(b.instance_id);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
    return c !== 0 ? c * sign : a.instance_id.localeCompare(b.instance_id);
  });
}

/** The next sort when a header is pressed: the same column flips, another starts at its first direction. */
export function nextInstanceSort(current: InstanceSort, key: InstanceSortKey): InstanceSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstInstanceDir(key) };
}

/** The instances of one environment; empty keeps every environment. */
export function filterInstances(instances: readonly AppInstance[], env: string): AppInstance[] {
  return env ? instances.filter((i) => i.environment === env) : [...instances];
}

/** The instance's memory cell: the share of its limit when known, else the working set or RSS. */
export function memoryCell(i: AppInstance): { main: string; sub: string } {
  const r = i.resources;
  if (!r) return { main: "—", sub: "" };
  const bytes = r.mem_working_set ?? r.mem_rss;
  if (r.mem_pct !== null) return { main: formatResource("percent", r.mem_pct), sub: bytes !== null ? formatBytes(bytes) : "" };
  return { main: formatResource("bytes", bytes), sub: r.mem_limit === null ? "no limit" : "" };
}

/** Where the instance runs, for its row: the pod, else the hostname. */
export const instanceWhere = (i: AppInstance): string => i.pod_name || i.hostname || "";

// Empty states ----------------------------------------------------------------------------------

export type ResourcesEmpty = "disabled" | "old_sdk" | "no_instances" | "no_data";

/**
 * Why the Resources tab has nothing to chart, or null when it has: sampling turned off by the
 * app's capture policy, every live instance on an SDK too old to sample, no instance at all, or
 * instances that sample but whose first samples have not landed (`hasData` false).
 */
export function resourcesEmpty(status: AppStatus | null, policy: CapturePolicy | null, hasData: boolean): ResourcesEmpty | null {
  if (policy?.resources && policy.resources.enabled === false) return "disabled";
  if (hasData) return null;
  const live = (status?.instances ?? []).filter((i) => !i.ended_at);
  if (status && live.length === 0) return "no_instances";
  if (live.length > 0 && live.every((i) => i.resources === null || i.resources === undefined)) return "old_sdk";
  return "no_data";
}

/** Whether a series has any value at all. */
export const seriesHasData = (points: readonly ResourcePoint[] | null | undefined): boolean => (points ?? []).some((p) => p.avg !== null);

// Runtime panel ---------------------------------------------------------------------------------

export type RuntimeKind = "python" | "node" | "java";

export const RUNTIME_LABEL: Record<RuntimeKind, string> = { python: "Python", node: "Node.js", java: "JVM" };

/** The runtime of an instance from its `runtime` string (`python 3.13.1`, `node 22.11.0`, `java 21.0.5`). */
export function runtimeKind(runtime: string | undefined): RuntimeKind | null {
  const r = (runtime ?? "").toLowerCase();
  if (r.startsWith("python") || r.startsWith("cpython") || r.startsWith("pypy")) return "python";
  if (r.startsWith("node") || r.startsWith("bun") || r.startsWith("deno")) return "node";
  if (r.startsWith("java") || r.startsWith("jvm") || r.startsWith("openjdk") || r.startsWith("graal")) return "java";
  return null;
}

/** The runtime most of the app's live instances run, or null. */
export function dominantRuntime(instances: readonly AppInstance[]): RuntimeKind | null {
  const n = new Map<RuntimeKind, number>();
  for (const i of instances) {
    if (i.ended_at) continue;
    const k = runtimeKind(i.runtime);
    if (k) n.set(k, (n.get(k) ?? 0) + 1);
  }
  let best: RuntimeKind | null = null;
  for (const [k, c] of n) if (best === null || c > (n.get(best) ?? 0)) best = k;
  return best;
}

/** The runtime panel's charts for each runtime (D6), as far as the resources API serves them. */
export const RUNTIME_METRICS: Record<RuntimeKind, readonly { metric: ResourceMetric; label: string }[]> = {
  node: [
    { metric: "event_loop_p99", label: "Event-loop delay p99" },
    { metric: "elu", label: "Event-loop utilization" },
    { metric: "heap_used", label: "V8 heap used" },
    { metric: "gc_pause", label: "GC pause" },
    { metric: "pool_used", label: "DB pool connections in use" },
  ],
  java: [
    { metric: "heap_used", label: "Heap used" },
    { metric: "gc_pause", label: "GC pause" },
    { metric: "threads", label: "Threads" },
    { metric: "pool_used", label: "DB pool connections in use" },
  ],
  python: [
    { metric: "gc_pause", label: "GC pause" },
    { metric: "threads", label: "Threads" },
    { metric: "pool_used", label: "DB pool connections in use" },
  ],
};

// Overview tiles --------------------------------------------------------------------------------

/** The share of the limit above which a resource tile warns. */
export const RESOURCE_WARN = 0.8;

/** The p-th percentile (0 to 1) of `values` by nearest rank; null without values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

export interface ResourceTile {
  /** The p95 over every live instance's minutes of the last hour, formatted. */
  value: string;
  /** That p95 as a share of the limit (0 to 1), or null without a limit. */
  share: number | null;
  warn: boolean;
  /** The average over instances for each minute, for the tile's sparkline. */
  spark: (number | null)[];
  sub: string;
}

function minuteAverages(series: readonly ((number | null)[] | null | undefined)[]): (number | null)[] {
  const n = Math.max(0, ...series.map((s) => s?.length ?? 0));
  return Array.from({ length: n }, (_, k) => {
    const vals = series.map((s) => s?.[k]).filter((v): v is number => v !== null && v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
}

/**
 * The Overview's CPU and memory tiles (#1134): the p95 over the live instances' last hour (each
 * instance's 60 one-minute points), warning above 80% of the limit. Serverless instances do not
 * count for CPU. Null tiles (no data) are hidden.
 */
export function resourceTiles(status: AppStatus | null): { cpu: ResourceTile | null; mem: ResourceTile | null } {
  const live = (status?.instances ?? []).filter((i) => !i.ended_at && i.resources);
  const cpuOf = live.filter((i) => !isServerless(i));
  const cpuVals = cpuOf.flatMap((i) => (i.spark?.cpu_pct ?? []).filter((v): v is number => v !== null));
  const cpuP95 = percentile(cpuVals, 0.95);
  const cpu: ResourceTile | null =
    cpuP95 === null
      ? null
      : {
          value: formatResource("percent", cpuP95),
          share: cpuP95 / 100,
          warn: cpuP95 / 100 > RESOURCE_WARN,
          spark: minuteAverages(cpuOf.map((i) => i.spark?.cpu_pct)),
          sub: `p95 of ${cpuOf.length} ${cpuOf.length === 1 ? "instance" : "instances"}, of the limit`,
        };
  // Memory as a share of each instance's own limit when every one has a limit; else bytes.
  const limited = live.every((i) => (i.resources?.mem_limit ?? 0) > 0);
  const memSeries = live.map((i) => {
    const lim = i.resources?.mem_limit ?? 0;
    return (i.spark?.mem ?? []).map((v) => (v === null ? null : limited ? v / lim : v));
  });
  const memVals = memSeries.flat().filter((v): v is number => v !== null);
  const memP95 = percentile(memVals, 0.95);
  const mem: ResourceTile | null =
    memP95 === null
      ? null
      : {
          value: limited ? formatResource("ratio", memP95) : formatResource("bytes", memP95),
          share: limited ? memP95 : null,
          warn: limited && memP95 > RESOURCE_WARN,
          spark: minuteAverages(memSeries),
          sub: `p95 of ${live.length} ${live.length === 1 ? "instance" : "instances"}${limited ? ", of the limit" : ", working set"}`,
        };
  return { cpu, mem };
}

export const RESOURCES_LOAD_FAILED = "We couldn’t load resources just now.";
export const EVENTS_LOAD_FAILED = "We couldn’t load restarts and OOM kills just now.";
