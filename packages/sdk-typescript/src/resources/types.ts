/**
 * Shapes shared by the sampler and its collectors. The block is the wire
 * contract `resources.v = 1` (internal/ingest/resources.go; golden fixtures
 * testdata/resources/heartbeat_v1*.json). An unmeasured field is absent.
 */

import type { CgroupSnapshot } from "./cgroup.js";
import type { Gauge } from "./window.js";

/** Collector names, as the heartbeat policy's `disabled_collectors` spells them. */
export type CollectorName =
  | "process.cpu"
  | "process.memory"
  | "process.pss"
  | "container.cpu"
  | "container.memory"
  | "runtime"
  | "pools"
  | "processes";

export const COLLECTOR_NAMES: readonly CollectorName[] = Object.freeze([
  "process.cpu",
  "process.memory",
  "process.pss",
  "container.cpu",
  "container.memory",
  "runtime",
  "pools",
  "processes",
]);

export type ResourcePool = {
  name: string;
  kind?: string;
  used?: Gauge;
  idle?: number;
  max?: number;
  pending?: Gauge;
};

export type ResourceProcess = {
  pid: number;
  ppid?: number;
  comm: string;
  cpu_pct?: number;
  rss?: number;
};

export type ResourcesBlock = {
  v: 1;
  window_s?: number;
  n?: number;
  sampler_cost_us?: number;
  capabilities: string[];
  limit_source?: "cgroup_v2" | "cgroup_v1" | "ecs" | "vm" | "host" | "none";
  process?: {
    cpu?: { cores_used?: Gauge; pct_of_limit?: Gauge };
    memory?: { rss?: Gauge; pss?: Gauge; uss?: Gauge };
    threads?: Gauge;
    fds?: Gauge;
  };
  container?: {
    container_id?: string;
    cpu?: {
      cores_used?: Gauge;
      pct_of_limit?: Gauge;
      limit_cores?: number;
      throttled_ratio?: number;
      throttled_us?: number;
    };
    memory?: {
      current?: Gauge;
      working_set?: Gauge;
      anon?: Gauge;
      file?: Gauge;
      swap?: Gauge;
      limit?: number;
      oom_kill?: number;
    };
  };
  runtime?: {
    node?: {
      event_loop_delay_ms?: { p50?: number; p99?: number; max?: number };
      elu?: Gauge;
      heap_used?: Gauge;
      heap_total?: Gauge;
      external?: Gauge;
      array_buffers?: Gauge;
      gc?: { count?: number; pause_ms_sum?: number; pause_ms_max?: number };
    };
  };
  pools?: ResourcePool[];
  processes?: ResourceProcess[];
  flags: string[];
};

/** What one tick of the sampler hands every collector. */
export type SampleContext = {
  /** Monotonic ms (`performance.now()`). */
  nowMs: number;
  /**
   * True when this tick follows a freeze (wall clock jumped by more than
   * twice the interval): rate collectors re-baseline instead of averaging
   * the frozen time in.
   */
  gap: boolean;
  /** True on the first tick and then about every 60 s: the slow reads are due. */
  slow: boolean;
  /** The cgroup reading of this tick (read once, shared), or null off Linux. */
  cgroup: () => CgroupSnapshot | null;
  /** Effective CPU cores this process may use: cgroup limit, else cpuset/affinity/host. */
  limitCores: () => number | undefined;
  /** Add a window flag (`host_pid_namespace`, …). */
  flag: (name: string) => void;
};

export interface Collector {
  readonly name: CollectorName;
  /** Capability token sent while the collector works (`process.cpu`, `runtime.node`, …). */
  readonly capability: string;
  /** Whether this runtime can measure it at all (checked once, at start). */
  available(): boolean;
  sample(ctx: SampleContext): void;
  /** Write the window into `out` and start a new one. */
  drain(out: ResourcesBlock): void;
  /** Release timers / observers (optional). */
  stop?(): void;
  /** False while it has nothing to report (no pool yet): left out of capabilities. */
  active?(): boolean;
}
