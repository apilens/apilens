// Axis ticks for the shared charts (#1004): round time ticks in the user's display time zone and
// the histogram's trimmed buckets and reference marks. Pure; safe in Client and Server Components.
import { zoneLabel, zoned, zoneOffsetMinutes } from "./time-zone";
import { formatLatency } from "./traffic";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * The tick spacings, smallest first. Each divides the next unit (a minute, an hour, a day), so a
 * tick always lands on a round wall-clock time, and midnight is always a tick when a range crosses
 * one at an hourly spacing.
 */
const STEPS = [
  SEC,
  2 * SEC,
  5 * SEC,
  10 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  3 * DAY,
  4 * DAY,
  7 * DAY,
  14 * DAY,
] as const;

export interface TimeTick {
  /** The tick's instant, epoch milliseconds. */
  at: number;
  /** `14:05`, `14:05:30` or `Nov 18` (at midnight, or for day spacings), in the zone. */
  label: string;
}

export interface TimeTicks {
  ticks: TimeTick[];
  /** The spacing picked, in milliseconds (0 when there is no range). */
  step: number;
  /** The zone's name for the axis (`UTC`, `IST`, `EST`), read at the range's end. */
  zone: string;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const CLOCK_SECONDS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** An instant as wall-clock milliseconds in `tz` (the instant plus the zone's offset then). */
const wall = (t: number, tz: string) => t + zoneOffsetMinutes(tz, t) * MIN;

/** The instant a wall-clock time in `tz` names (the later offset wins in a repeated hour). */
function fromWall(w: number, tz: string): number {
  const guess = w - zoneOffsetMinutes(tz, w) * MIN;
  return w - zoneOffsetMinutes(tz, guess) * MIN;
}

/** The wall-clock times of `step` spacing from `from` to `to`, as instants; skips times DST removes. */
function ticksAt(from: number, to: number, step: number, tz: string): number[] {
  const w0 = wall(from, tz);
  const w1 = wall(to, tz);
  // Day spacings count whole days; weeks start on a Monday (1970-01-05 was one).
  const anchor = step >= 7 * DAY ? 4 * DAY : 0;
  let w = Math.ceil((w0 - anchor) / step) * step + anchor;
  const out: number[] = [];
  // A DST change moves an instant's wall time by at most a few hours: look a step beyond each end.
  for (w -= step; w <= w1 + step; w += step) {
    const t = fromWall(w, tz);
    if (t < from || t > to) continue;
    // A wall time the clocks skipped (spring forward) maps back to another one: no tick.
    if (wall(t, tz) !== w) continue;
    if (out.length && out[out.length - 1] === t) continue;
    out.push(t);
  }
  return out;
}

/**
 * 3–5 round time ticks between `from` and `to` (epoch ms), in `tz`: the smallest spacing whose
 * ticks number at most `max`. Ticks fall on round wall-clock times in the zone (14:00, 14:15 in
 * IST, midnight in New York across a DST change), labelled `HH:mm`, `HH:mm:ss` under a minute, and
 * with the date (`Nov 18`) at midnight or when the spacing is a day or more.
 */
export function timeTicks(from: number, to: number, tz: string, max = 5): TimeTicks {
  const zone = Number.isFinite(to) ? zoneLabel(tz, to) : zoneLabel(tz);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || max < 1) return { ticks: [], step: 0, zone };
  const span = to - from;
  for (const step of STEPS) {
    // Cheap bound first: at least span/step - 1 ticks fit.
    if (span / step - 1 > max) continue;
    const at = ticksAt(from, to, step, tz);
    if (at.length === 0 || at.length > max) continue;
    return { ticks: at.map((t) => ({ at: t, label: tickLabel(t, step, tz) })), step, zone };
  }
  return { ticks: [{ at: from, label: tickLabel(from, DAY, tz) }], step: 0, zone };
}

function tickLabel(t: number, step: number, tz: string): string {
  if (step >= DAY) return zoned("en-US", DATE, tz).format(t);
  if (step < MIN) return zoned("en-US", CLOCK_SECONDS, tz).format(t);
  const clock = zoned("en-US", CLOCK, tz).format(t);
  return clock === "00:00" ? zoned("en-US", DATE, tz).format(t) : clock;
}

/**
 * The x of an instant along a bucketed time axis, 0–1: buckets start at `first` and are `step` ms
 * wide, `count` of them, each a slot of equal width (as the charts draw them).
 */
export function timeFraction(t: number, first: number, step: number, count: number): number {
  if (!(step > 0) || count <= 0) return 0;
  return Math.min(1, Math.max(0, (t - first) / (step * count)));
}

/** A histogram bucket with its numeric edges; the last may have no upper edge. */
export interface EdgedBucket {
  label: string;
  count: number;
  from: number;
  to?: number | null;
}

/** A value marked on a histogram (#1004): p50, p95, the Apdex threshold T. */
export interface Mark {
  key: "p50" | "p95" | "t";
  /** The tag on the line and in the legend: `p50`, `p95`, `T`. */
  label: string;
  /** In the buckets' unit (ms for response times). */
  value: number;
  /** The value as the legend writes it: `120 ms`. */
  text: string;
}

/** The marks of a response-time histogram: p50, p95 and, when known, the Apdex threshold T. */
export function latencyMarks(s: { p50_ms: number; p95_ms: number }, thresholdMs?: number | null): Mark[] {
  const marks: Mark[] = [
    { key: "p50", label: "p50", value: s.p50_ms, text: formatLatency(s.p50_ms) },
    { key: "p95", label: "p95", value: s.p95_ms, text: formatLatency(s.p95_ms) },
  ];
  if (thresholdMs && thresholdMs > 0) marks.push({ key: "t", label: "T", value: thresholdMs, text: formatLatency(thresholdMs) });
  return marks;
}

/**
 * Where `value` falls along histogram slots, 0–1: inside its bucket, linearly between the edges;
 * past the last bucket, at the middle of the open-ended bucket or the end. Null when no bucket.
 */
export function bucketFraction(buckets: readonly Pick<EdgedBucket, "from" | "to">[], value: number): number | null {
  const n = buckets.length;
  if (n === 0 || !Number.isFinite(value)) return null;
  if (value <= buckets[0].from) return 0;
  for (let i = 0; i < n; i++) {
    const { from, to } = buckets[i];
    if (to === undefined || to === null) return value >= from ? (i + 0.5) / n : i / n;
    if (value < to) return (i + (value - from) / (to - from)) / n;
  }
  return 1;
}

/**
 * The buckets a histogram draws: the empty ones at the end dropped, but never one a mark falls in
 * (so p95 or T stays on the chart), and at least one bucket.
 */
export function trimHistogram<B extends Pick<EdgedBucket, "count" | "from" | "to">>(buckets: readonly B[], marks: readonly number[] = []): B[] {
  let last = -1;
  buckets.forEach((b, i) => {
    if (b.count > 0) last = i;
  });
  for (const v of marks) {
    if (!Number.isFinite(v)) continue;
    const i = buckets.findIndex((b) => b.to === undefined || b.to === null || v < b.to);
    if (i > last) last = i;
  }
  return buckets.slice(0, Math.max(1, last + 1));
}

/**
 * Which bar labels to show when bars are `slot` px wide and a label needs `need` px: every k-th
 * (always the first), so labels never overlap.
 */
export function labelEvery(slot: number, need: number): number {
  if (!(slot > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(need / slot));
}
