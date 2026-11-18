// Explore timeline (#587): requests per bucket by status class above the log. A click on a bar
// jumps the log to that time (`?at=`), a drag across bars zooms both to that window
// (`?from=&to=`). Pure helpers (URL window, bucket geometry, selection, labels, the poll answer),
// unit-tested in explore-timeline.test.ts.
import type { RequestTimeline, RequestTimelineBucket } from "./identity";
import { zoneLabel, zoned } from "./time-zone";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The timeline's part of the page state, RFC 3339 in UTC to the second. */
export interface ExploreWindow {
  /** Zoom start (inclusive). */
  from?: string;
  /** Zoom end (exclusive). */
  to?: string;
  /** The jump point: the log lists requests before it, newest first. */
  at?: string;
}

/** An instant as the URL carries it: `2026-11-05T10:02:00Z` (milliseconds dropped). */
export const isoSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

/** A URL time, normalised, or undefined when it is missing or not a time. */
function timeParam(v: string | undefined): string | undefined {
  if (!v || v.length > 40) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : isoSecond(t);
}

/**
 * Reads the window from search params. A zoom whose start is not before its end is dropped, and so
 * is a jump point outside the zoom (at or before its start, after its end).
 */
export function parseWindow(params: SearchParams): ExploreWindow {
  const from = timeParam(first(params.from));
  const to = timeParam(first(params.to));
  const at = timeParam(first(params.at));
  const out: ExploreWindow = {};
  if (!(from && to && Date.parse(from) >= Date.parse(to))) {
    if (from) out.from = from;
    if (to) out.to = to;
  }
  if (at && !(out.from && Date.parse(at) <= Date.parse(out.from)) && !(out.to && Date.parse(at) > Date.parse(out.to))) out.at = at;
  return out;
}

/** The window's search entries in a fixed order. */
export function windowEntries(w: ExploreWindow): [keyof ExploreWindow, string][] {
  const out: [keyof ExploreWindow, string][] = [];
  if (w.from) out.push(["from", w.from]);
  if (w.to) out.push(["to", w.to]);
  if (w.at) out.push(["at", w.at]);
  return out;
}

/** The `from`/`to` the log reads: the zoom, its end pulled in to the jump point. */
export function logWindow(w: ExploreWindow): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (w.from) out.from = w.from;
  // parseWindow keeps a jump point only inside the zoom, so it is never past the zoom's end.
  const to = w.at ?? w.to;
  if (to) out.to = to;
  return out;
}

/** The `from`/`to` the timeline reads: the zoom only (the jump point moves the log, not the chart). */
export const chartWindow = (w: ExploreWindow): { from?: string; to?: string } => ({ ...(w.from ? { from: w.from } : {}), ...(w.to ? { to: w.to } : {}) });

export const isZoomed = (w: ExploreWindow) => Boolean(w.from || w.to);

/** The status classes the bars stack, bottom up. */
export const TIMELINE_SERIES = [
  { key: "successful", label: "Successful", className: "ex-tl-ok" },
  { key: "client_errors", label: "4xx", className: "ex-tl-4xx" },
  { key: "server_errors", label: "5xx", className: "ex-tl-5xx" },
] as const satisfies readonly { key: keyof RequestTimelineBucket; label: string; className: string }[];

/** A move narrower than this many px is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** The bucket under `x` px of a plot `width` px wide holding `count` buckets, clamped to the ends. */
export function bucketAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** Start and end (ms) of bucket `i`, its end capped at the window's end. */
export function bucketSpan(t: Pick<RequestTimeline, "to" | "bucket_seconds">, b: Pick<RequestTimelineBucket, "ts">): { start: number; end: number } {
  const start = Date.parse(b.ts);
  return { start, end: Math.min(start + t.bucket_seconds * 1000, Date.parse(t.to)) };
}

/**
 * The zoom a drag across buckets `a`..`b` (either order) asks for: from the start of the first to
 * the end of the last, the start no earlier than the window's.
 */
export function selectionWindow(t: RequestTimeline, a: number, b: number): { from: string; to: string } | null {
  const buckets = t.buckets ?? [];
  if (buckets.length === 0) return null;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(buckets.length - 1, Math.max(a, b));
  const from = Math.max(Date.parse(buckets[lo].ts), Date.parse(t.from));
  const to = bucketSpan(t, buckets[hi]).end;
  if (!(to > from)) return null;
  return { from: isoSecond(from), to: isoSecond(Math.ceil(to / 1000) * 1000) };
}

/** The jump point of a click on bucket `i`: its end, so the log opens on that bucket's newest request. */
export function jumpPoint(t: RequestTimeline, i: number): string | null {
  const b = t.buckets?.[i];
  if (!b) return null;
  return isoSecond(Math.ceil(bucketSpan(t, b).end / 1000) * 1000);
}

/** The x (px) of an instant on the plot, or null when it is outside the timeline's buckets. */
export function timeX(t: RequestTimeline, iso: string, width: number): number | null {
  const buckets = t.buckets ?? [];
  if (buckets.length === 0) return null;
  const start = Date.parse(buckets[0].ts);
  const span = buckets.length * t.bucket_seconds * 1000;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at < start || at > start + span) return null;
  return ((at - start) / span) * width;
}

/**
 * The bucket a key moves the keyboard focus to from `current`, or null for keys the chart leaves
 * alone. Shift is handled by the caller (it extends the selection with the same moves).
 */
export function moveBucket(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return Math.min(count - 1, current + 1);
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const TIME_S: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/**
 * An instant for labels, in `tz`: `14:05`, `14:05:30` when `seconds`, with the day in front
 * (`Nov 5, 14:05`) when `withDay`. The caller adds the zone (`zoneLabel`) once per label.
 */
export function formatInstant(iso: string, { tz, seconds = false, withDay = false }: { tz: string; seconds?: boolean; withDay?: boolean }): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const time = zoned("en-US", seconds ? TIME_S : TIME, tz).format(t);
  return withDay ? `${zoned("en-US", DAY, tz).format(t)}, ${time}` : time;
}

/** How a timeline labels its instants: seconds below one-minute buckets, the day from 6 h windows up. */
export function labelStyle(t: Pick<RequestTimeline, "from" | "to" | "bucket_seconds">): { seconds: boolean; withDay: boolean } {
  return { seconds: t.bucket_seconds < 60, withDay: Date.parse(t.to) - Date.parse(t.from) >= 6 * 3600_000 };
}

/** A window in words, in `tz`: `10:02 to 10:14 UTC`, `Nov 4, 22:00 to Nov 5, 02:00 UTC`. */
export function windowText(from: string, to: string, tz: string): string {
  const day = zoned("en-US", DAY, tz);
  const seconds = Date.parse(from) % 60_000 !== 0 || Date.parse(to) % 60_000 !== 0;
  const withDay = day.format(Date.parse(from)) !== day.format(Date.parse(to)) || Date.parse(to) - Date.parse(from) >= 24 * 3600_000;
  return `${formatInstant(from, { tz, seconds, withDay })} to ${formatInstant(to, { tz, seconds, withDay })} ${zoneLabel(tz, Date.parse(to))}`;
}

/** An instant in words, in `tz`: `10:14 UTC`, `10:14:30 UTC`. */
export const instantText = (iso: string, tz: string) => `${formatInstant(iso, { tz, seconds: Date.parse(iso) % 60_000 !== 0 })} ${zoneLabel(tz, Date.parse(iso))}`;

const COUNT = new Intl.NumberFormat("en-US");

/** A bucket for its tooltip and the screen reader: its time, total and split. */
export function bucketText(t: RequestTimeline, b: RequestTimelineBucket, tz: string): string {
  const { start, end } = bucketSpan(t, b);
  const when = windowText(isoSecond(start), isoSecond(Math.ceil(end / 1000) * 1000), tz);
  const n = (v: number) => COUNT.format(v);
  return `${when}: ${n(b.requests)} ${b.requests === 1 ? "request" : "requests"} (${n(b.successful)} successful, ${n(b.client_errors)} 4xx, ${n(b.server_errors)} 5xx)`;
}

/** One poll of the timeline Route Handler. */
export type TimelinePoll = { kind: "timeline"; timeline: RequestTimeline } | { kind: "expired"; next: string } | { kind: "error"; code: string };

/** Reads the Route Handler's answer (`{ok: true, timeline}` or `{ok: false, code, next?}`). */
export function timelinePoll(status: number, body: unknown): TimelinePoll {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.ok === true && typeof b.timeline === "object" && b.timeline !== null) return { kind: "timeline", timeline: b.timeline as RequestTimeline };
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  return { kind: "error", code };
}

export const TIMELINE_LOAD_FAILED = "We couldn’t load the timeline just now. The log below still works.";

/** The timeline's window summed: all requests and each status class (the header's summary). */
export function timelineTotals(t: Pick<RequestTimeline, "buckets">): Pick<RequestTimelineBucket, "requests" | "successful" | "client_errors" | "server_errors"> {
  const sum = { requests: 0, successful: 0, client_errors: 0, server_errors: 0 };
  for (const b of t.buckets ?? []) {
    sum.requests += b.requests;
    sum.successful += b.successful;
    sum.client_errors += b.client_errors;
    sum.server_errors += b.server_errors;
  }
  return sum;
}

// ---------------------------------------------------------------- Supabase TimelineChart (#1061)
// apps/studio/components/ui/DataTable/TimelineChart.tsx (supabase/supabase master): the chart's
// tick and tooltip formats by the span of its buckets, and recharts' default tick thinning.

/** TimelineChart.tsx:199-211 `calculatePeriod`, by the span from the first to the last bucket. */
export type ChartPeriod = "10m" | "1d" | "1w" | "1mo";
export function chartPeriod(intervalMs: number): ChartPeriod {
  if (intervalMs <= 10 * 60_000) return "10m";
  if (intervalMs <= 24 * 3_600_000) return "1d";
  if (intervalMs <= 7 * 24 * 3_600_000) return "1w";
  return "1mo";
}

const HMS: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
const HM: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const MON_DD: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit" };
const MON_DD_Y: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit", year: "numeric" };

/**
 * An x-axis tick (TimelineChart.tsx:137-148): `HH:mm:ss` up to 10 minutes, `HH:mm` up to a day,
 * `LLL dd HH:mm` up to a week, else `LLL dd, y`, in `tz`.
 */
export function chartTick(at: number, period: ChartPeriod, tz: string): string {
  if (period === "10m") return zoned("en-US", HMS, tz).format(at);
  if (period === "1d") return zoned("en-US", HM, tz).format(at);
  if (period === "1w") return `${zoned("en-US", MON_DD, tz).format(at)} ${zoned("en-US", HM, tz).format(at)}`;
  return zoned("en-US", MON_DD_Y, tz).format(at);
}

/** The tooltip's label (TimelineChart.tsx:156-163): `LLL dd, HH:mm:ss` up to 10 minutes, else `LLL dd, y HH:mm`. */
export function chartTooltipLabel(at: number, period: ChartPeriod, tz: string): string {
  if (period === "10m") return `${zoned("en-US", MON_DD, tz).format(at)}, ${zoned("en-US", HMS, tz).format(at)}`;
  return `${zoned("en-US", MON_DD_Y, tz).format(at)} ${zoned("en-US", HM, tz).format(at)}`;
}

/**
 * Which bucket indices get a tick, as recharts' default `interval="preserveEnd"` with
 * `minTickGap={32}` (TimelineChart.tsx:135) picks them: from the last bucket backwards, a tick
 * wherever its label (`labelPx` wide, centred on its bucket of `slotPx`) clears the one after it
 * by `gap` px. Ascending.
 */
export function chartTickIndices(count: number, slotPx: number, labelPx: number, gap = 32): number[] {
  if (count <= 0 || slotPx <= 0) return [];
  const out: number[] = [];
  let edge = Number.POSITIVE_INFINITY;
  for (let i = count - 1; i >= 0; i--) {
    const center = (i + 0.5) * slotPx;
    if (out.length === 0 || center + labelPx / 2 + gap <= edge) {
      out.push(i);
      edge = center - labelPx / 2;
    }
  }
  return out.reverse();
}
