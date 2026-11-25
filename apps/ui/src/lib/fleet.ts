// The fleet behind one app in one environment (M7 Resources, the fleet table): the SDK processes
// grouped into the unit a load balancer sends traffic to and a limit applies to: a pod, a
// container, a VM. Forked workers (gunicorn, Node cluster) fold into their unit; the unit's
// traffic share, latency and headroom are compared with the rest of the fleet, so a hot, slow or
// starved instance stands out instead of hiding in an average. Pure: no React, no fetch.

import type { AppInstance, InstanceEvent } from "./identity";
import { PLATFORM_LABEL, isServerless } from "./resources";

/** What a unit is, for the copy ("3 VMs", "6 pods on 2 nodes"). */
export type UnitKind = "pod" | "container" | "vm" | "process";

/** One load-balanced unit and the SDK processes (workers) running in it. */
export interface FleetUnit {
  key: string;
  kind: UnitKind;
  /** The name an operator knows it by: pod name, hostname, else the instance id. */
  name: string;
  /** Where it runs: node, zone or region, platform. */
  node: string;
  region: string;
  platform: string;
  release: string;
  workers: AppInstance[];
  /** CPU in cores across the workers, and as a percent of the unit's limit (null: unmeasured). */
  cpuCores: number | null;
  cpuLimitCores: number | null;
  cpuPct: number | null;
  /** What the CPU percent is of: the cgroup or host limit. */
  cpuOf: "limit" | "host" | null;
  /** Memory in bytes, its limit and percent, and how it was measured. */
  memBytes: number | null;
  memLimit: number | null;
  memPct: number | null;
  memOf: "working_set" | "pss" | "rss" | null;
  throttled: number | null;
  /** Requests of the last 15 minutes: per minute (all workers), p95 of the slowest worker, error share. */
  rpm: number | null;
  p95: number | null;
  errorPct: number | null;
  /** Share of the fleet's requests (0..1), null without request stats. */
  share: number | null;
  /** The longest-running worker's uptime: how long the unit has been up. */
  uptimeS: number | null;
  /** Restarts and OOM kills in the events window. */
  restarts: number;
  ooms: number;
  /** Why it needs a look, most pressing first; empty when it is fine. */
  findings: Finding[];
  /** 0 = fine; higher sorts first. */
  attention: number;
  /** An old SDK: listed, nothing measured. */
  unmeasured: boolean;
  /** Lambda / Cloud Run: not behind the same load balancer, never compared with the fleet. */
  serverless: boolean;
}

export type FindingTone = "critical" | "warning" | "info";
export interface Finding {
  key: string;
  tone: FindingTone;
  /** A short label for the row ("Memory 94% of limit"). */
  label: string;
  /** The sentence behind it, for the tooltip and the summary. */
  detail: string;
}

/** How the page should present the fleet. */
export type FleetMode = "fleet" | "single" | "serverless" | "empty";

const MEM_CRITICAL = 90;
const MEM_WARNING = 80;
const CPU_WARNING = 85;
const THROTTLE_WARNING = 0.2;
const SHARE_HIGH = 1.5;
const SHARE_LOW = 0.5;
const SLOW_FACTOR = 1.5;
const SLOW_MIN_MS = 100;

const sum = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const maxOf = (xs: (number | null | undefined)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The unit a process belongs to: its container (all workers of a pod or container share it), else
 * its host when it runs straight on a VM, else the process itself.
 */
export function unitKey(i: AppInstance): string {
  if (i.container_id) return `c:${i.container_id}`;
  if (i.hostname && !i.hostname_guess && !isServerless(i)) return `h:${i.hostname}`;
  return `p:${i.instance_id}`;
}

function unitKind(i: AppInstance): UnitKind {
  if (i.platform === "k8s" && i.pod_name) return "pod";
  if (i.container_id) return "container";
  if (i.hostname && !i.hostname_guess && !isServerless(i)) return "vm";
  return "process";
}

/** The environment a fleet view opens on: production when it has live instances, else the busiest. */
export function defaultEnvironment(instances: readonly AppInstance[]): string {
  const live = instances.filter((i) => !i.ended_at && i.environment);
  const counts = new Map<string, number>();
  for (const i of live) counts.set(i.environment, (counts.get(i.environment) ?? 0) + 1);
  if (counts.has("production")) return "production";
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
}

/** The environments with live instances, production first. */
export function fleetEnvironments(instances: readonly AppInstance[]): string[] {
  const envs = [...new Set(instances.filter((i) => !i.ended_at && i.environment).map((i) => i.environment))];
  return envs.sort((a, b) => (a === "production" ? -1 : b === "production" ? 1 : a.localeCompare(b)));
}

function memoryOf(workers: AppInstance[]): Pick<FleetUnit, "memBytes" | "memLimit" | "memPct" | "memOf"> {
  const rs = workers.map((w) => w.resources).filter((r): r is NonNullable<AppInstance["resources"]> => !!r);
  if (rs.length === 0) return { memBytes: null, memLimit: null, memPct: null, memOf: null };
  const limit = maxOf(rs.map((r) => r.mem_limit));
  // The container's working set is the same number in every worker: take it once, never add it up.
  const ws = maxOf(rs.map((r) => r.mem_working_set));
  if (ws !== null) return { memBytes: ws, memLimit: limit, memPct: limit ? (ws / limit) * 100 : null, memOf: "working_set" };
  // No container: add the workers' PSS (shared pages split between them), else their RSS.
  const pss = rs.every((r) => typeof r.mem_pss === "number") ? sum(rs.map((r) => r.mem_pss)) : null;
  if (pss !== null) return { memBytes: pss, memLimit: limit, memPct: limit ? (pss / limit) * 100 : null, memOf: "pss" };
  const rss = sum(rs.map((r) => r.mem_rss));
  return { memBytes: rss, memLimit: limit, memPct: limit && rss !== null ? (rss / limit) * 100 : null, memOf: rss === null ? null : "rss" };
}

function cpuOf(workers: AppInstance[]): Pick<FleetUnit, "cpuCores" | "cpuLimitCores" | "cpuPct" | "cpuOf"> {
  const rs = workers.map((w) => w.resources).filter((r): r is NonNullable<AppInstance["resources"]> => !!r);
  // CPU time is not shared between processes, so the workers' cores add up to the unit's.
  const cores = sum(rs.map((r) => r.cpu_cores));
  const limit = maxOf(rs.map((r) => r.cpu_limit_cores));
  if (cores === null) return { cpuCores: null, cpuLimitCores: limit, cpuPct: null, cpuOf: null };
  if (limit) return { cpuCores: cores, cpuLimitCores: limit, cpuPct: (cores / limit) * 100, cpuOf: rs.some((r) => r.limit_source === "host" || r.limit_source === "vm") ? "host" : "limit" };
  return { cpuCores: cores, cpuLimitCores: null, cpuPct: null, cpuOf: null };
}

/** The units of one environment's live processes, with fleet comparisons and attention order. */
export function buildFleet(instances: readonly AppInstance[], env: string, events: readonly InstanceEvent[] | null): FleetUnit[] {
  const live = instances.filter((i) => !i.ended_at && (!env || i.environment === env));
  const groups = new Map<string, AppInstance[]>();
  for (const i of live) {
    const k = unitKey(i);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const units: FleetUnit[] = [...groups.entries()].map(([key, workers]) => {
    const w0 = workers[0];
    const withReq = workers.filter((w) => w.requests);
    const rpm = sum(withReq.map((w) => w.requests?.rpm));
    const errorPct =
      rpm && rpm > 0 ? (sum(withReq.map((w) => (w.requests?.rpm ?? 0) * (w.requests?.error_pct ?? 0))) ?? 0) / rpm : withReq.length ? 0 : null;
    const ids = new Set(workers.map((w) => w.instance_id));
    const containers = new Set(workers.map((w) => w.container_id).filter(Boolean));
    const pods = new Set(workers.map((w) => w.pod_name).filter(Boolean));
    const evs = (events ?? []).filter((e) => ids.has(e.instance_id) || (e.container_id && containers.has(e.container_id)) || (e.pod_name && pods.has(e.pod_name)));
    return {
      key,
      kind: unitKind(w0),
      name: w0.pod_name || (w0.hostname && !w0.hostname_guess ? w0.hostname : "") || w0.instance_id,
      node: w0.node_name ?? "",
      region: w0.region ?? "",
      platform: w0.platform ?? "",
      release: w0.release ?? "",
      workers: [...workers].sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0)),
      ...cpuOf(workers),
      ...memoryOf(workers),
      throttled: maxOf(workers.map((w) => w.resources?.throttled_ratio)),
      rpm,
      p95: rpm && rpm > 0 ? maxOf(withReq.filter((w) => (w.requests?.rpm ?? 0) > 0).map((w) => w.requests?.p95_ms)) : null,
      errorPct,
      share: null,
      uptimeS: maxOf(workers.map((w) => w.uptime_s)),
      restarts: distinctEvents(evs.filter((e) => e.kind === "restart" || e.kind === "oom" || e.kind === "suspected_oom")),
      ooms: distinctEvents(evs.filter((e) => e.kind === "oom" || e.kind === "oom_kill")),
      findings: [],
      attention: 0,
      unmeasured: workers.every((w) => !w.resources),
      serverless: workers.every(isServerless),
    };
  });
  compare(units);
  return units.sort((a, b) => b.attention - a.attention || (b.memPct ?? -1) - (a.memPct ?? -1) || (b.rpm ?? -1) - (a.rpm ?? -1) || a.name.localeCompare(b.name));
}

/**
 * Restarts and kills as the operator counts them: one per container (or pod) and minute, however
 * many of its workers the same event ended.
 */
function distinctEvents(evs: readonly InstanceEvent[]): number {
  return new Set(evs.map((e) => `${e.container_id || e.pod_name || e.instance_id}@${e.at.slice(0, 16)}`)).size;
}

/** Traffic share and the findings that compare each unit with the rest of the fleet. */
function compare(units: FleetUnit[]): void {
  // Serverless instances sit behind their own front door: never part of the load-balanced fleet.
  const serving = units.filter((u) => u.rpm !== null && !u.serverless);
  const total = sum(serving.map((u) => u.rpm)) ?? 0;
  const n = serving.length;
  const fair = n > 0 ? 1 / n : 0;
  // When one unit takes far more than its share, the others are low because of it: name the hot
  // one only. "Little traffic" is for a unit starved while the rest are even (draining, failing
  // health checks).
  const hot = n >= 2 && total > 0 && serving.some((u) => (u.rpm ?? 0) / total / fair >= SHARE_HIGH);
  const medP95 = median(serving.filter((u) => u.p95 !== null && (u.rpm ?? 0) > 0).map((u) => u.p95 as number));
  for (const u of units) {
    const f: Finding[] = [];
    if (u.rpm !== null && total > 0 && !u.serverless) u.share = u.rpm / total;
    if (u.ooms > 0) f.push({ key: "oom", tone: "critical", label: u.ooms === 1 ? "OOM killed" : `OOM killed ${u.ooms}×`, detail: "The kernel's OOM killer ended a process here: it hit the memory limit." });
    else if (u.restarts > 0) f.push({ key: "restart", tone: "warning", label: u.restarts === 1 ? "Restarted" : `Restarted ${u.restarts}×`, detail: "A process here ended and was replaced." });
    if (u.memPct !== null && u.memPct >= MEM_CRITICAL)
      f.push({ key: "mem", tone: "critical", label: `Memory ${Math.round(u.memPct)}% of limit`, detail: "Near its memory limit: the next spike can get it OOM killed." });
    else if (u.memPct !== null && u.memPct >= MEM_WARNING) f.push({ key: "mem", tone: "warning", label: `Memory ${Math.round(u.memPct)}% of limit`, detail: "Memory is getting close to its limit." });
    if (u.throttled !== null && u.throttled >= THROTTLE_WARNING)
      f.push({ key: "throttle", tone: "warning", label: `CPU throttled ${Math.round(u.throttled * 100)}%`, detail: "It hits its CPU quota and waits: requests slow down even though average CPU looks fine." });
    else if (u.cpuPct !== null && u.cpuPct >= CPU_WARNING) f.push({ key: "cpu", tone: "warning", label: `CPU ${Math.round(u.cpuPct)}%`, detail: "CPU is close to what it is allowed to use." });
    if (n >= 2 && u.share !== null && fair > 0) {
      const ratio = u.share / fair;
      if (ratio >= SHARE_HIGH) f.push({ key: "share", tone: "warning", label: `${ratio.toFixed(1)}× its share of traffic`, detail: `Gets ${Math.round(u.share * 100)}% of requests where an even spread across ${n} would be ${Math.round(fair * 100)}%. Check the load balancer's weights and health checks.` });
      else if (!hot && ratio < SHARE_LOW) f.push({ key: "share", tone: "info", label: "Little traffic", detail: `Gets ${Math.round(u.share * 100)}% of requests where an even spread across ${n} would be ${Math.round(fair * 100)}%. It may be failing health checks or draining.` });
    }
    if (n >= 2 && !u.serverless && medP95 !== null && u.p95 !== null && u.p95 >= medP95 * SLOW_FACTOR && u.p95 - medP95 >= SLOW_MIN_MS)
      f.push({ key: "slow", tone: "warning", label: `p95 ${(u.p95 / medP95).toFixed(1)}× the fleet`, detail: `p95 ${Math.round(u.p95)} ms against a fleet median of ${Math.round(medP95)} ms.` });
    for (const s of u.workers.flatMap((w) => w.signals ?? [])) {
      if (s.kind === "leak" && !f.some((x) => x.key === "leak")) f.push({ key: "leak", tone: "warning", label: `Leak +${Math.round(s.value)} MB/h`, detail: s.detail });
    }
    const weight: Record<FindingTone, number> = { critical: 100, warning: 10, info: 1 };
    // Something already broke (an OOM kill) outranks something about to.
    const score = (x: Finding) => weight[x.tone] * (x.key === "oom" ? 2 : 1);
    u.findings = f.sort((a, b) => score(b) - score(a));
    u.attention = f.reduce((a, x) => a + score(x), 0);
  }
}

/** How to present a fleet: a table, one instance's card, the serverless summary, or nothing. */
export function fleetMode(units: readonly FleetUnit[]): FleetMode {
  if (units.length === 0) return "empty";
  if (units.every((u) => u.workers.every(isServerless))) return "serverless";
  if (units.length === 1) return "single";
  return "fleet";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const KIND_NOUN: Record<UnitKind, [string, string]> = { pod: ["pod", "pods"], container: ["container", "containers"], vm: ["host", "hosts"], process: ["instance", "instances"] };

/**
 * One line naming the fleet: "6 pods on 3 nodes · 24 workers", "3 hosts behind a load balancer ·
 * 12 workers", "1 host · 4 workers". Mixed kinds fall back to "instances".
 */
export function describeFleet(all: readonly FleetUnit[]): string {
  const units = all.filter((u) => !u.serverless);
  const extra = all.length - units.length;
  const tail = extra > 0 ? `${plural(extra, "serverless instance")}` : "";
  if (units.length === 0) return tail;
  const kinds = new Set(units.map((u) => u.kind));
  const kind: UnitKind = kinds.size === 1 ? units[0].kind : "process";
  const [one, many] = KIND_NOUN[kind];
  const parts = [plural(units.length, one, many)];
  const nodes = new Set(units.map((u) => u.node).filter(Boolean));
  if (kind === "pod" && nodes.size > 0) parts[0] += ` on ${plural(nodes.size, "node")}`;
  else if (units.length > 1 && (kind === "vm" || kind === "container")) parts[0] += " behind a load balancer";
  const platforms = new Set(units.map((u) => u.platform).filter(Boolean));
  if (platforms.size === 1 && kind !== "pod") {
    const p = PLATFORM_LABEL[[...platforms][0]];
    if (p && kind !== "vm") parts[0] += ` on ${p}`;
  }
  const workers = units.reduce((n, u) => n + u.workers.length, 0);
  if (workers > units.length) parts.push(plural(workers, "worker"));
  if (tail) parts.push(`plus ${tail}`);
  return parts.join(" · ");
}

/** How the fleet's traffic is spread: even, or the share of the busiest unit when it is not. */
export function balanceLine(units: readonly FleetUnit[]): { even: boolean; text: string } | null {
  const serving = units.filter((u) => u.share !== null && !u.serverless);
  if (serving.length < 2) return null;
  const top = [...serving].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  const fair = 1 / serving.length;
  const ratio = (top.share ?? 0) / fair;
  if (ratio < SHARE_HIGH) return { even: true, text: `Traffic is spread evenly across ${serving.length}.` };
  return { even: false, text: `${top.name} takes ${Math.round((top.share ?? 0) * 100)}% of requests; even would be ${Math.round(fair * 100)}%.` };
}

/** The unit's memory as it reads in a cell: "94% of 1 GB" or "412 MB" with what it measures. */
export function memoryLabel(u: Pick<FleetUnit, "memOf" | "memLimit" | "memPct">): string {
  const what = u.memOf === "working_set" ? "Container working set" : u.memOf === "pss" ? "Workers' PSS added up" : u.memOf === "rss" ? "Workers' RSS added up (shared pages counted once per worker)" : "";
  const of = u.memLimit ? ` against the ${u.memOf === "working_set" ? "container" : "host"} limit` : ", no limit set";
  return what ? `${what}${of}.` : "";
}
