/**
 * The SDK process's own CPU and memory (D4–D5).
 *
 * - CPU: `process.cpuUsage(prev)` microsecond deltas over `performance.now()`,
 *   as cores busy and as a percent of the effective limit (never
 *   `os.cpus().length`, which ignores quotas and affinity).
 * - RSS: `process.memoryUsage.rss()` every sample (it does not walk the heap).
 * - Threads and file descriptors from /proc/self (Linux).
 * - PSS / USS from /proc/self/smaps_rollup every 60 s (Linux), turned off
 *   after the first failed read (a permission error, an old kernel).
 */

import type * as nodeOs from "node:os";

import { builtin, processObject } from "../runtime.js";
import { type Reader, colonFields, kbField } from "./fs.js";
import type { Collector, ResourcesBlock, SampleContext } from "./types.js";
import { GaugeAcc, compact } from "./window.js";

type CpuUsage = { user: number; system: number };

type NodeProcess = {
  cpuUsage?: (prev?: CpuUsage) => CpuUsage;
  memoryUsage?: (() => { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers?: number })
    & { rss?: () => number };
  constrainedMemory?: () => number | undefined;
  platform?: string;
};

export function nodeProcess(): NodeProcess | undefined {
  return processObject() as NodeProcess | undefined;
}

/** True on Linux, where /proc is there to read. */
export function isLinux(): boolean {
  return nodeProcess()?.platform === "linux";
}

/** Host CPUs this process may run on (`availableParallelism` honours affinity). */
export function hostCores(): number | undefined {
  try {
    const os = builtin<typeof nodeOs & { availableParallelism?: () => number }>("os");
    const n = os?.availableParallelism?.() ?? os?.cpus?.().length;
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Host memory in bytes, or undefined. */
export function hostMemTotal(): number | undefined {
  try {
    const n = builtin<typeof nodeOs>("os")?.totalmem?.();
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `process.constrainedMemory()` as a limit in bytes, or null: it answers 0
 * (or undefined) without a limit and a huge number (2^64-1, or above the
 * host's memory) on some cgroup setups, which are not limits.
 */
export function normalizeConstrainedMemory(value: unknown, hostMem: number | undefined = hostMemTotal()): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 2 ** 62) {
    return null;
  }
  if (hostMem !== undefined && value >= hostMem) {
    return null;
  }
  return value;
}

/** The process's constrained memory limit, or null. */
export function constrainedMemory(): number | null {
  try {
    return normalizeConstrainedMemory(nodeProcess()?.constrainedMemory?.());
  } catch {
    return null;
  }
}

export class ProcessCpuCollector implements Collector {
  readonly name = "process.cpu" as const;
  readonly capability = "process.cpu";
  private prev?: CpuUsage;
  private prevAt = 0;
  private cores = new GaugeAcc();
  private pct = new GaugeAcc();

  available(): boolean {
    return typeof nodeProcess()?.cpuUsage === "function";
  }

  sample(ctx: SampleContext): void {
    const usage = nodeProcess()?.cpuUsage?.();
    if (!usage) {
      return;
    }
    const prev = this.prev;
    const elapsedUs = (ctx.nowMs - this.prevAt) * 1000;
    this.prev = usage;
    this.prevAt = ctx.nowMs;
    // The first sample is the baseline; after a freeze, re-baseline rather
    // than spread the CPU over the frozen time.
    if (!prev || ctx.gap || !(elapsedUs > 0)) {
      return;
    }
    const used = Math.max(usage.user + usage.system - prev.user - prev.system, 0) / elapsedUs;
    this.cores.add(used);
    const limit = ctx.limitCores();
    if (limit !== undefined && limit > 0) {
      this.pct.add(Math.min((used / limit) * 100, 100));
    }
  }

  drain(out: ResourcesBlock): void {
    const cpu = compact({ cores_used: this.cores.drain(), pct_of_limit: this.pct.drain(2) });
    if (cpu) {
      out.process = { ...out.process, cpu };
    }
  }
}

export class ProcessMemoryCollector implements Collector {
  readonly name = "process.memory" as const;
  readonly capability = "process.memory";
  private rss = new GaugeAcc();
  private threads = new GaugeAcc();
  private fds = new GaugeAcc();

  constructor(private readonly reader: Reader, private readonly linux: boolean) {}

  available(): boolean {
    return typeof nodeProcess()?.memoryUsage === "function";
  }

  sample(): void {
    const mu = nodeProcess()?.memoryUsage;
    this.rss.add(typeof mu?.rss === "function" ? mu.rss() : mu?.().rss);
    if (this.linux) {
      const threads = Number(colonFields(this.reader.text("/proc/self/status")).get("Threads"));
      this.threads.add(Number.isFinite(threads) && threads > 0 ? threads : undefined);
      this.fds.add(this.reader.list("/proc/self/fd")?.length);
    }
  }

  drain(out: ResourcesBlock): void {
    const rss = this.rss.drain(0);
    const threads = this.threads.drain(2);
    const fds = this.fds.drain(2);
    const process = { ...out.process };
    if (rss) {
      process.memory = { ...process.memory, rss };
    }
    if (threads) {
      process.threads = threads;
    }
    if (fds) {
      process.fds = fds;
    }
    out.process = process;
  }
}

export class ProcessPssCollector implements Collector {
  readonly name = "process.pss" as const;
  readonly capability = "process.pss";
  private pss = new GaugeAcc();
  private uss = new GaugeAcc();
  private broken = false;

  constructor(private readonly reader: Reader, private readonly linux: boolean) {}

  available(): boolean {
    return this.linux && !this.broken;
  }

  active(): boolean {
    return !this.broken;
  }

  sample(ctx: SampleContext): void {
    if (!ctx.slow || this.broken) {
      return;
    }
    const fields = colonFields(this.reader.text("/proc/self/smaps_rollup"));
    const pss = kbField(fields, "Pss");
    if (pss === undefined) {
      // Missing or not permitted: it will not get better, stop trying.
      this.broken = true;
      return;
    }
    this.pss.add(pss);
    const clean = kbField(fields, "Private_Clean");
    const dirty = kbField(fields, "Private_Dirty");
    this.uss.add(clean !== undefined && dirty !== undefined ? clean + dirty : undefined);
  }

  drain(out: ResourcesBlock): void {
    const pss = this.pss.drain(0);
    const uss = this.uss.drain(0);
    if (pss || uss) {
      const process = { ...out.process };
      process.memory = { ...process.memory, ...compact({ pss, uss }) };
      out.process = process;
    }
  }
}
