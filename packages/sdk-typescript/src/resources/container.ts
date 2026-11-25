/**
 * The container (the process's cgroup), from the cgroup reader (D3–D5).
 * Every worker of a container sends the same numbers with the container id;
 * the server keeps one series per container and never adds workers up.
 *
 * CPU usage is a rate over the cgroup's `usage_us` counter; throttling and
 * OOM kills are counter deltas over the window. Container memory is the
 * cgroup's own (`memory.current`, working set), never a sum of RSS.
 */

import type { Collector, ResourcesBlock, SampleContext } from "./types.js";
import { CounterAcc, GaugeAcc, compact, round } from "./window.js";

const nn = (v: number | null | undefined): number | undefined => (v === null ? undefined : v);

export class ContainerCpuCollector implements Collector {
  readonly name = "container.cpu" as const;
  readonly capability = "container.cpu";
  private prevUsage?: number;
  private prevAt = 0;
  private cores = new GaugeAcc();
  private pct = new GaugeAcc();
  private periods = new CounterAcc();
  private throttled = new CounterAcc();
  private throttledUs = new CounterAcc();
  private limit?: number;
  private seen = false;

  constructor(private readonly linux: boolean) {}

  available(): boolean {
    return this.linux;
  }

  active(): boolean {
    return this.seen;
  }

  sample(ctx: SampleContext): void {
    const cpu = ctx.cgroup()?.cpu;
    if (!cpu) {
      return;
    }
    this.seen = true;
    this.limit = nn(cpu.limit_cores);
    const usage = nn(cpu.usage_us);
    const prev = this.prevUsage;
    const elapsedUs = (ctx.nowMs - this.prevAt) * 1000;
    this.prevUsage = usage;
    this.prevAt = ctx.nowMs;
    if (usage !== undefined && prev !== undefined && !ctx.gap && elapsedUs > 0 && usage >= prev) {
      const used = (usage - prev) / elapsedUs;
      this.cores.add(used);
      const limit = ctx.limitCores();
      if (limit !== undefined && limit > 0) {
        this.pct.add(Math.min((used / limit) * 100, 100));
      }
    }
    this.periods.add(nn(cpu.nr_periods));
    this.throttled.add(nn(cpu.nr_throttled));
    this.throttledUs.add(nn(cpu.throttled_us));
  }

  drain(out: ResourcesBlock): void {
    const periods = this.periods.drain();
    const throttled = this.throttled.drain();
    const cpu = compact({
      cores_used: this.cores.drain(),
      pct_of_limit: this.pct.drain(2),
      limit_cores: this.limit,
      // No CFS period in the window (no quota): the ratio is not measurable.
      throttled_ratio: periods && throttled !== undefined ? round(Math.min(throttled / periods, 1), 4) : undefined,
      throttled_us: this.throttledUs.drain(),
    });
    if (cpu) {
      out.container = { ...out.container, cpu };
    }
  }
}

export class ContainerMemoryCollector implements Collector {
  readonly name = "container.memory" as const;
  readonly capability = "container.memory";
  private current = new GaugeAcc();
  private workingSet = new GaugeAcc();
  private anon = new GaugeAcc();
  private file = new GaugeAcc();
  private swap = new GaugeAcc();
  private oomKill = new CounterAcc();
  private limit?: number;
  private seen = false;

  constructor(private readonly linux: boolean) {}

  available(): boolean {
    return this.linux;
  }

  active(): boolean {
    return this.seen;
  }

  sample(ctx: SampleContext): void {
    const memory = ctx.cgroup()?.memory;
    if (!memory) {
      return;
    }
    this.seen = true;
    this.limit = nn(memory.limit);
    this.current.add(memory.current);
    this.workingSet.add(memory.working_set);
    this.anon.add(memory.anon);
    this.file.add(memory.file);
    this.swap.add(memory.swap);
    this.oomKill.add(memory.oom_kill);
  }

  drain(out: ResourcesBlock): void {
    const memory = compact({
      current: this.current.drain(0),
      working_set: this.workingSet.drain(0),
      anon: this.anon.drain(0),
      file: this.file.drain(0),
      swap: this.swap.drain(0),
      limit: this.limit,
      oom_kill: this.oomKill.drain(),
    });
    if (memory) {
      out.container = { ...out.container, memory };
    }
  }
}
