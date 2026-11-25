/**
 * Processes in the SDK's own container (D8), Linux only, every 60 s: the top
 * 20 by RSS with pid, ppid, `comm` (15 characters), CPU % of one core and RSS.
 *
 * Only processes whose /proc/<pid>/cgroup equals ours are kept, so with
 * `shareProcessNamespace` other containers' processes stay out. Command lines,
 * environments and working directories are NEVER read: only `status` (name,
 * ppid, VmRSS), `stat` (CPU ticks) and `cgroup`. A host PID namespace
 * (/proc/1 is systemd or init and there are more than 500 processes) turns
 * the listing off for good, with the `host_pid_namespace` flag.
 */

import { type Reader, colonFields, kbField } from "./fs.js";
import type { Collector, ResourceProcess, ResourcesBlock, SampleContext } from "./types.js";
import { round } from "./window.js";

export const MAX_PROCESSES = 20;
const HOST_PID_THRESHOLD = 500;
/** Clock ticks per second of /proc/<pid>/stat (USER_HZ is 100 on every Linux ABI). */
const CLK_TCK = 100;
const MAX_COMM = 15;

/** utime + stime in ticks from /proc/<pid>/stat (the comm may contain spaces and parens). */
function cpuTicks(stat: string | null): number | undefined {
  if (!stat) {
    return undefined;
  }
  const close = stat.lastIndexOf(")");
  const rest = stat.slice(close + 2).split(" ");
  // rest[0] is field 3 (state): utime is field 14, stime field 15.
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : undefined;
}

export class ProcessListCollector implements Collector {
  readonly name = "processes" as const;
  readonly capability = "processes";
  private hostPid = false;
  private latest?: ResourceProcess[];
  private prevTicks = new Map<number, number>();
  private prevAt?: number;

  constructor(private readonly reader: Reader, private readonly linux: boolean) {}

  available(): boolean {
    return this.linux;
  }

  active(): boolean {
    return !this.hostPid;
  }

  sample(ctx: SampleContext): void {
    if (this.hostPid) {
      ctx.flag("host_pid_namespace");
      return;
    }
    if (!ctx.slow) {
      return;
    }
    const pids = (this.reader.list("/proc") ?? []).filter((name) => /^\d+$/.test(name)).map(Number);
    const init = (this.reader.text("/proc/1/comm") ?? "").trim();
    if ((init === "systemd" || init === "init") && pids.length > HOST_PID_THRESHOLD) {
      this.hostPid = true;
      this.latest = undefined;
      ctx.flag("host_pid_namespace");
      return;
    }
    const own = this.reader.text("/proc/self/cgroup");
    if (own === null) {
      return;
    }
    const elapsedS = this.prevAt === undefined || ctx.gap ? undefined : (ctx.nowMs - this.prevAt) / 1000;
    const ticks = new Map<number, number>();
    const found: ResourceProcess[] = [];
    for (const pid of pids) {
      if (this.reader.text(`/proc/${pid}/cgroup`) !== own) {
        continue;
      }
      const status = colonFields(this.reader.text(`/proc/${pid}/status`));
      const rss = kbField(status, "VmRSS");
      const comm = (status.get("Name") ?? "").slice(0, MAX_COMM);
      if (rss === undefined || !comm) {
        // Kernel threads and processes that exited meanwhile.
        continue;
      }
      const proc: ResourceProcess = { pid, comm, rss };
      const ppid = Number(status.get("PPid"));
      if (Number.isInteger(ppid) && ppid >= 0) {
        proc.ppid = ppid;
      }
      const t = cpuTicks(this.reader.text(`/proc/${pid}/stat`));
      if (t !== undefined) {
        ticks.set(pid, t);
        const before = this.prevTicks.get(pid);
        if (elapsedS && elapsedS > 0 && before !== undefined && t >= before) {
          proc.cpu_pct = round(((t - before) / CLK_TCK / elapsedS) * 100, 2);
        }
      }
      found.push(proc);
    }
    this.prevTicks = ticks;
    this.prevAt = ctx.nowMs;
    found.sort((a, b) => (b.rss ?? 0) - (a.rss ?? 0));
    this.latest = found.slice(0, MAX_PROCESSES);
  }

  drain(out: ResourcesBlock): void {
    if (this.latest && this.latest.length > 0) {
      out.processes = this.latest.map((p) => ({ ...p }));
    }
  }
}
