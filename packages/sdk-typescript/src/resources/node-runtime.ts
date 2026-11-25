/**
 * Node.js runtime internals (D6), feature-detected so Bun and Deno report
 * what they have and nothing else:
 *
 * - Event loop delay: `monitorEventLoopDelay({ resolution: 20 })`, reported in
 *   ms as p50 / p99 / max of the window and `reset()` at every heartbeat
 *   (otherwise the percentiles are lifetime values).
 * - Event loop utilization: the delta between two `eventLoopUtilization()`
 *   snapshots; the first call is cumulative since start and is discarded.
 * - Heap: the full `process.memoryUsage()` (it walks the heap) on the first
 *   sample and then every 60 s only.
 * - GC: a `PerformanceObserver` on `gc` entries: count, pause sum and max.
 */

import type * as perfHooks from "node:perf_hooks";

import { builtin } from "../runtime.js";
import { nodeProcess } from "./process.js";
import type { Collector, ResourcesBlock, SampleContext } from "./types.js";
import { GaugeAcc, compact, round } from "./window.js";

type Histogram = {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(p: number): number;
  max: number;
  count?: number;
  exceeds?: number;
};

type Elu = { idle: number; active: number; utilization: number };

type PerfHooks = {
  monitorEventLoopDelay?: (options: { resolution: number }) => Histogram;
  performance?: { eventLoopUtilization?: (a?: Elu, b?: Elu) => Elu };
  PerformanceObserver?: typeof perfHooks.PerformanceObserver;
};

const NS_PER_MS = 1e6;

export class NodeRuntimeCollector implements Collector {
  readonly name = "runtime" as const;
  readonly capability = "runtime.node";
  private histogram?: Histogram;
  private observer?: { disconnect(): void };
  private prevElu?: Elu;
  private elu = new GaugeAcc();
  private heapUsed = new GaugeAcc();
  private heapTotal = new GaugeAcc();
  private external = new GaugeAcc();
  private arrayBuffers = new GaugeAcc();
  private gcCount = 0;
  private gcSum = 0;
  private gcMax = 0;
  private gcObserved = false;
  private started = false;
  /** The delay of the window still open when the collector was stopped (final heartbeat). */
  private stoppedDelay?: { p50?: number; p99?: number; max?: number };

  constructor(private readonly hooks: PerfHooks | undefined = builtin<PerfHooks>("perf_hooks")) {}

  available(): boolean {
    const h = this.hooks;
    return Boolean(
      h && (typeof h.monitorEventLoopDelay === "function" || typeof h.performance?.eventLoopUtilization === "function"),
    ) || typeof nodeProcess()?.memoryUsage === "function";
  }

  private start(): void {
    this.started = true;
    try {
      const histogram = this.hooks?.monitorEventLoopDelay?.({ resolution: 20 });
      if (histogram) {
        histogram.enable();
        this.histogram = histogram;
      }
    } catch {
      this.histogram = undefined;
    }
    try {
      const Observer = this.hooks?.PerformanceObserver;
      if (typeof Observer === "function") {
        const observer = new Observer((list) => {
          for (const entry of list.getEntries()) {
            const ms = entry.duration;
            if (Number.isFinite(ms) && ms >= 0) {
              this.gcCount += 1;
              this.gcSum += ms;
              this.gcMax = Math.max(this.gcMax, ms);
            }
          }
        });
        observer.observe({ entryTypes: ["gc"] });
        this.observer = observer;
        this.gcObserved = true;
      }
    } catch {
      this.observer = undefined;
    }
  }

  sample(ctx: SampleContext): void {
    if (!this.started) {
      this.start();
    }
    const eluFn = this.hooks?.performance?.eventLoopUtilization;
    if (typeof eluFn === "function") {
      const now = eluFn.call(this.hooks?.performance);
      const prev = this.prevElu;
      this.prevElu = now;
      // The first snapshot covers the whole process lifetime: baseline only.
      if (prev && !ctx.gap) {
        this.elu.add(eluFn.call(this.hooks?.performance, now, prev).utilization);
      }
    }
    if (ctx.slow) {
      const mu = nodeProcess()?.memoryUsage?.();
      if (mu) {
        this.heapUsed.add(mu.heapUsed);
        this.heapTotal.add(mu.heapTotal);
        this.external.add(mu.external);
        this.arrayBuffers.add(mu.arrayBuffers);
      }
    }
  }

  /** The window's event loop delay percentiles in ms; resets the histogram. */
  private delay(): { p50?: number; p99?: number; max?: number } | undefined {
    const h = this.histogram;
    if (!h) {
      return undefined;
    }
    try {
      const count = typeof h.count === "number" ? h.count : undefined;
      const max = h.max;
      // No sample yet: the histogram's max is 0 and its min a sentinel.
      if (count === 0 || !(max > 0)) {
        return undefined;
      }
      return compact({
        p50: round(h.percentile(50) / NS_PER_MS, 3),
        p99: round(h.percentile(99) / NS_PER_MS, 3),
        max: round(max / NS_PER_MS, 3),
      });
    } finally {
      h.reset();
    }
  }

  drain(out: ResourcesBlock): void {
    const gc = this.gcObserved
      ? { count: this.gcCount, pause_ms_sum: round(this.gcSum, 3), pause_ms_max: round(this.gcMax, 3) }
      : undefined;
    this.gcCount = 0;
    this.gcSum = 0;
    this.gcMax = 0;
    const delay = this.histogram ? this.delay() : this.stoppedDelay;
    this.stoppedDelay = undefined;
    const node = compact({
      event_loop_delay_ms: delay,
      elu: this.elu.drain(4),
      heap_used: this.heapUsed.drain(0),
      heap_total: this.heapTotal.drain(0),
      external: this.external.drain(0),
      array_buffers: this.arrayBuffers.drain(0),
      gc,
    });
    if (node) {
      out.runtime = { ...out.runtime, node };
    }
  }

  stop(): void {
    if (this.histogram) {
      try {
        this.stoppedDelay = this.delay();
      } catch {
        this.stoppedDelay = undefined;
      }
    }
    try {
      this.histogram?.disable();
    } catch {
      // Already gone.
    }
    try {
      this.observer?.disconnect();
    } catch {
      // Already gone.
    }
    this.histogram = undefined;
    this.observer = undefined;
    this.started = false;
  }
}
