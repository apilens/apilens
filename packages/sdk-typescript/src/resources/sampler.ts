/**
 * The resource sampler (D1, D11): every `resourcesIntervalMs` (default and
 * minimum 15 s) it asks each collector for a sample; every heartbeat drains
 * the window into the `resources` block (contract v1).
 *
 * Safety rules:
 * - The timer is unref'd: the sampler never keeps the process alive.
 * - Every collector is isolated: an error is counted and swallowed, and five
 *   failures in a row turn that collector off. Nothing ever throws into the app.
 * - The sampler measures its own cost (`sampler_cost_us`) and doubles its
 *   interval (up to 8x) while one sample costs more than 0.1 % of a core over
 *   the interval, coming back down once it is cheap again.
 * - A wall-clock jump of more than twice the interval (a Lambda / Cloud Run
 *   freeze) flags the window `freeze_gap` and re-baselines the rate
 *   collectors, so frozen time never dilutes CPU.
 * - The remote policy only narrows: it can turn sampling or single collectors
 *   off and lengthen the interval, never the reverse.
 */

import { type CgroupSnapshot, readCgroup } from "./cgroup.js";
import { ContainerCpuCollector, ContainerMemoryCollector } from "./container.js";
import { type Reader, fileReader } from "./fs.js";
import { NodeRuntimeCollector } from "./node-runtime.js";
import { PoolsCollector } from "./pools.js";
import {
  ProcessCpuCollector,
  ProcessMemoryCollector,
  ProcessPssCollector,
  hostCores as detectHostCores,
  hostMemTotal,
  isLinux,
} from "./process.js";
import { ProcessListCollector } from "./processes.js";
import type { Collector, CollectorName, ResourcesBlock, SampleContext } from "./types.js";
import { round } from "./window.js";

export const RESOURCES_INTERVAL_MS = 15_000;
export const RESOURCES_MIN_INTERVAL_MS = 15_000;
const SLOW_EVERY_MS = 60_000;
/** Budget of one sample: 0.1 % of one core over the interval. */
const BUDGET_SHARE = 0.001;
const MAX_BACKOFF = 8;
const MAX_FAILURES = 5;
/** Heartbeats of several apps within this long share one drained window. */
const SHARED_DRAIN_MS = 5_000;

/** The `policy.resources` of a heartbeat response. */
export type ResourcesPolicy = {
  enabled: boolean;
  /** Shortest interval allowed, in seconds (0: no floor). */
  minIntervalS: number;
  disabledCollectors: string[];
};

export type SamplerOptions = {
  intervalMs?: number;
  captureProcessList?: boolean;
  /** Filesystem root for /proc and /sys reads (tests). */
  root?: string;
  reader?: Reader;
  /** Override the collectors (tests). */
  collectors?: Collector[];
  linux?: boolean;
  hostCores?: number;
  /** The identity's platform: picks `vm` vs `host` and the `serverless` flag. */
  platform?: string;
  /** Monotonic clock in ms (default `performance.now()`). */
  now?: () => number;
  /** Wall clock in ms (default `Date.now()`). */
  wallNow?: () => number;
  /** False: no timer; the owner calls `sampleIfDue()` (inline flush mode). */
  timers?: boolean;
  env?: Record<string, string | undefined>;
};

type Slot = { collector: Collector; failures: number; errors: number; off: boolean; usable: boolean };

function monotonic(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/** The block an edge runtime sends: it can measure nothing (D13). */
export function edgeResourcesBlock(): ResourcesBlock {
  return { v: 1, capabilities: [], flags: [] };
}

export class ResourceSampler {
  readonly localIntervalMs: number;
  private readonly slots: Slot[];
  private readonly linux: boolean;
  private readonly cores: number | undefined;
  private readonly memTotal: number | undefined;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly timers: boolean;
  private readonly staticFlags: string[] = [];
  private readonly platform: string | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private policyOff = false;
  private policyMinMs = 0;
  private policyDisabled = new Set<string>();
  private backoff = 1;
  private lastWall?: number;
  private lastSampleAt?: number;
  private lastSlowAt?: number;
  private rebaseline = false;
  private windowStart: number;
  private n = 0;
  private costUs = 0;
  private flags = new Set<string>();
  private lastCgroup: CgroupSnapshot | null = null;
  private shared?: { at: number; block: ResourcesBlock };
  private readonly readCgroupFn: () => CgroupSnapshot;

  constructor(options: SamplerOptions = {}) {
    this.localIntervalMs = Math.max(
      Number.isFinite(options.intervalMs) ? Number(options.intervalMs) : RESOURCES_INTERVAL_MS,
      RESOURCES_MIN_INTERVAL_MS,
    );
    this.linux = options.linux ?? isLinux();
    this.cores = options.hostCores ?? detectHostCores();
    this.memTotal = hostMemTotal();
    this.now = options.now ?? monotonic;
    this.wallNow = options.wallNow ?? Date.now;
    this.timers = options.timers !== false;
    this.platform = options.platform;
    this.windowStart = this.wallNow();
    const reader = options.reader ?? fileReader(options.root ?? "");
    this.readCgroupFn = () => readCgroup({ reader, hostCores: this.cores, hostMemTotal: this.memTotal });
    const collectors = options.collectors ?? [
      new ProcessCpuCollector(),
      new ProcessMemoryCollector(reader, this.linux),
      new ProcessPssCollector(reader, this.linux),
      new ContainerCpuCollector(this.linux),
      new ContainerMemoryCollector(this.linux),
      new NodeRuntimeCollector(),
      new PoolsCollector(),
      ...(options.captureProcessList === false ? [] : [new ProcessListCollector(reader, this.linux)]),
    ];
    this.slots = collectors.map((collector) => {
      let usable = false;
      try {
        usable = collector.available();
      } catch {
        usable = false;
      }
      return { collector, failures: 0, errors: 0, off: false, usable };
    });
    if (this.platform === "lambda" || this.platform === "cloud_run") {
      this.staticFlags.push("serverless");
    }
    const appInstance = (options.env ?? {}).NODE_APP_INSTANCE?.trim();
    if (appInstance && /^\d{1,6}$/.test(appInstance)) {
      // PM2 / cluster worker number, so workers of one host tell apart.
      this.staticFlags.push(`node_app_instance.${appInstance}`);
    }
  }

  /** The interval in force: local, raised by the policy, times the cost backoff. */
  get intervalMs(): number {
    return Math.max(this.localIntervalMs, this.policyMinMs) * this.backoff;
  }

  /** Errors per collector so far (diagnostics and tests). */
  errorCounts(): Partial<Record<CollectorName, number>> {
    const out: Partial<Record<CollectorName, number>> = {};
    for (const slot of this.slots) {
      if (slot.errors > 0) {
        out[slot.collector.name] = slot.errors;
      }
    }
    return out;
  }

  /** Whether a collector was turned off after repeated failures. */
  isCollectorOff(name: CollectorName): boolean {
    return this.slots.some((s) => s.collector.name === name && s.off);
  }

  /** Take the first sample now and keep sampling every interval. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    if (this.policyOff) {
      return;
    }
    this.sampleNow();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    for (const slot of this.slots) {
      try {
        slot.collector.stop?.();
      } catch {
        // Nothing to release.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.timers || !this.running || this.policyOff) {
      return;
    }
    const timer = setInterval(() => this.sampleNow(), this.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private enabled(name: CollectorName): boolean {
    return !this.policyDisabled.has(name);
  }

  /** Inline mode (no timer): sample when an interval has passed since the last one. */
  sampleIfDue(): void {
    if (!this.running || this.policyOff) {
      return;
    }
    const last = this.lastSampleAt;
    if (last === undefined || this.now() - last >= this.intervalMs) {
      this.sampleNow();
    }
  }

  /** One sample of every collector. Never throws. */
  sampleNow(): void {
    if (this.policyOff) {
      return;
    }
    try {
      this.sampleInner();
    } catch {
      // The sampler itself must never fail the app.
    }
  }

  private sampleInner(): void {
    const t0 = this.now();
    const wall = this.wallNow();
    let gap = this.rebaseline;
    this.rebaseline = false;
    if (this.lastWall !== undefined && wall - this.lastWall > 2 * this.intervalMs) {
      gap = true;
      this.flags.add("freeze_gap");
    }
    const slow = this.lastSlowAt === undefined || t0 - this.lastSlowAt >= SLOW_EVERY_MS - this.intervalMs / 2;
    let cgroup: CgroupSnapshot | null | undefined;
    const ctx: SampleContext = {
      nowMs: t0,
      gap,
      slow,
      cgroup: () => {
        if (cgroup === undefined) {
          try {
            cgroup = this.linux ? this.readCgroupFn() : null;
          } catch {
            cgroup = null;
          }
          this.lastCgroup = cgroup;
        }
        return cgroup;
      },
      limitCores: () => {
        const cpu = ctx.cgroup()?.cpu;
        if (cpu?.limit_cores !== null && cpu?.limit_cores !== undefined) {
          return cpu.limit_cores;
        }
        const cpuset = cpu?.cpuset_cores ?? undefined;
        if (cpuset !== undefined && this.cores !== undefined) {
          return Math.min(cpuset, this.cores);
        }
        return cpuset ?? this.cores;
      },
      flag: (name) => this.flags.add(name),
    };
    for (const slot of this.slots) {
      if (!slot.usable || slot.off || !this.enabled(slot.collector.name)) {
        continue;
      }
      try {
        slot.collector.sample(ctx);
        slot.failures = 0;
      } catch {
        this.fail(slot);
      }
    }
    // Read the cgroup at least once per window, for limit_source and the id.
    if (this.linux && cgroup === undefined) {
      ctx.cgroup();
    }
    this.lastWall = wall;
    this.lastSampleAt = t0;
    if (slow) {
      this.lastSlowAt = t0;
    }
    const cost = Math.max((this.now() - t0) * 1000, 0);
    this.n += 1;
    this.costUs += cost;
    this.adjustBackoff(cost);
  }

  private fail(slot: Slot): void {
    slot.errors += 1;
    slot.failures += 1;
    if (slot.failures >= MAX_FAILURES) {
      slot.off = true;
      try {
        slot.collector.stop?.();
      } catch {
        // Already broken.
      }
    }
  }

  private adjustBackoff(costUs: number): void {
    const budgetUs = this.intervalMs * 1000 * BUDGET_SHARE;
    const before = this.backoff;
    if (costUs > budgetUs && this.backoff < MAX_BACKOFF) {
      this.backoff *= 2;
    } else if (costUs < budgetUs / 4 && this.backoff > 1) {
      this.backoff /= 2;
    }
    if (this.backoff !== before) {
      this.schedule();
    }
  }

  private limitSource(): ResourcesBlock["limit_source"] {
    const cg = this.lastCgroup;
    if (cg && cg.limit_source !== "none") {
      return cg.limit_source;
    }
    if (this.cores === undefined) {
      return "none";
    }
    return this.platform === "vm" ? "vm" : "host";
  }

  /**
   * The window as a `resources` block, then a fresh window. Undefined while
   * the remote policy has resources off. Heartbeats of several apps within
   * a few seconds of each other get the same block.
   */
  drain(): ResourcesBlock | undefined {
    if (this.policyOff) {
      return undefined;
    }
    const wall = this.wallNow();
    if (this.shared && wall - this.shared.at < SHARED_DRAIN_MS) {
      return structuredCloneSafe(this.shared.block);
    }
    const out: ResourcesBlock = { v: 1, capabilities: [], flags: [] };
    if (this.n > 0) {
      out.window_s = round(Math.max(wall - this.windowStart, 0) / 1000, 1);
      out.n = this.n;
      out.sampler_cost_us = round(this.costUs / this.n, 1);
    }
    for (const slot of this.slots) {
      if (!slot.usable || slot.off) {
        continue;
      }
      const target: ResourcesBlock = this.enabled(slot.collector.name) ? out : { v: 1, capabilities: [], flags: [] };
      try {
        slot.collector.drain(target);
      } catch {
        this.fail(slot);
        continue;
      }
      let active = true;
      try {
        active = slot.collector.active?.() ?? true;
      } catch {
        active = false;
      }
      if (target === out && active && !out.capabilities.includes(slot.collector.capability)) {
        out.capabilities.push(slot.collector.capability);
      }
    }
    out.limit_source = this.limitSource();
    const id = this.lastCgroup?.container_id;
    if (out.container && id) {
      out.container = { container_id: id, ...out.container };
    }
    out.flags = [...new Set([...this.staticFlags, ...this.flags])];
    this.flags.clear();
    this.n = 0;
    this.costUs = 0;
    this.windowStart = wall;
    this.shared = { at: wall, block: out };
    return structuredCloneSafe(out);
  }

  /** Apply the heartbeat response's `policy.resources` (undefined: local config only). */
  applyPolicy(policy: ResourcesPolicy | undefined): void {
    const wasOff = this.policyOff;
    const beforeMs = this.intervalMs;
    this.policyOff = policy ? !policy.enabled : false;
    this.policyMinMs = policy && policy.minIntervalS > 0 ? policy.minIntervalS * 1000 : 0;
    this.policyDisabled = new Set(policy?.disabledCollectors ?? []);
    if (this.policyOff && !wasOff) {
      this.clearTimer();
      this.shared = undefined;
      return;
    }
    if (!this.policyOff && wasOff) {
      // Resume: a fresh window, and no rate spanning the time it was off.
      this.lastWall = undefined;
      this.rebaseline = true;
      this.n = 0;
      this.costUs = 0;
      this.windowStart = this.wallNow();
      if (this.running) {
        this.sampleNow();
        this.schedule();
      }
      return;
    }
    if (this.intervalMs !== beforeMs) {
      this.schedule();
    }
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
