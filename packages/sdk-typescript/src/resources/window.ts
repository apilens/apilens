/**
 * Window aggregators for the heartbeat's `resources` block (contract v1,
 * internal/ingest/resources.go): gauges become `{min, avg, max, last}` over
 * the samples of the window, counters become the sum of their increases.
 *
 * Nothing here ever turns "not measured" into 0: a gauge with no sample and
 * a counter with no step drain to undefined, and the field is left out.
 */

/** One sampled value over the window. Any field may be absent. */
export type Gauge = { min?: number; avg?: number; max?: number; last?: number };

/** A finite number, else undefined (NaN, Infinity, null and non-numbers). */
export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Round to `digits` decimals, keeping the payload small and readable. */
export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** min / avg / max / last of the values added since the last drain. */
export class GaugeAcc {
  private n = 0;
  private sum = 0;
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;
  private latest: number | undefined;

  add(value: number | null | undefined): void {
    const v = finite(value);
    if (v === undefined) {
      return;
    }
    this.n += 1;
    this.sum += v;
    this.lo = Math.min(this.lo, v);
    this.hi = Math.max(this.hi, v);
    this.latest = v;
  }

  get count(): number {
    return this.n;
  }

  /** The window's gauge (undefined without a sample), then a fresh window. */
  drain(digits = 4): Gauge | undefined {
    if (this.n === 0 || this.latest === undefined) {
      return undefined;
    }
    const out: Gauge = {
      min: round(this.lo, digits),
      avg: round(this.sum / this.n, digits),
      max: round(this.hi, digits),
      last: round(this.latest, digits),
    };
    this.n = 0;
    this.sum = 0;
    this.lo = Number.POSITIVE_INFINITY;
    this.hi = Number.NEGATIVE_INFINITY;
    this.latest = undefined;
    return out;
  }
}

/**
 * A monotonic counter (cgroup `oom_kill`, `nr_throttled`, …) reported as its
 * increase over the window. A value lower than the previous one (a counter
 * reset, a new cgroup) re-baselines instead of going negative.
 */
export class CounterAcc {
  private prev: number | undefined;
  private sum = 0;
  private steps = 0;

  add(value: number | null | undefined): void {
    const v = finite(value);
    if (v === undefined) {
      return;
    }
    if (this.prev !== undefined && v >= this.prev) {
      this.sum += v - this.prev;
      this.steps += 1;
    }
    this.prev = v;
  }

  /** The increase over the window, or undefined when no step was seen. */
  drain(): number | undefined {
    if (this.steps === 0) {
      return undefined;
    }
    const out = this.sum;
    this.sum = 0;
    this.steps = 0;
    return out;
  }
}

/** Copy of `obj` without undefined values (and undefined when that is empty). */
export function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}
