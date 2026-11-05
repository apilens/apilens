// Explore (#585, filters #586): the project's request log, newest first, read again every 5 s while live.
// Pure helpers (URL state, row formatting, the virtual window, keyboard moves, the poll answer),
// unit-tested in explore.test.ts.
import { RANGE_LABEL } from "./consumers";
import { type ExploreFilters, NO_FILTERS, filterEntries, parseFilters } from "./explore-filters";
import { type ExploreWindow, chartWindow, instantText, logWindow, parseWindow, windowEntries, windowText } from "./explore-timeline";
import type { QueryRange, RequestRow } from "./identity";

export const EXPLORE_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: QueryRange = "1h";
/** The most rows one page of `GET /requests` answers, and what the log shows. */
export const LOG_LIMIT = 200;
/** How often the log reads again while live. Every range ends now, so the log can always be live. */
export const LOG_POLL_MS = 5_000;
/** Height of one row in px; the virtual window depends on it, so the CSS uses the same number. */
export const ROW_HEIGHT = 40;
/** Rows rendered above and below the visible ones. */
export const OVERSCAN = 8;
/**
 * Latency thresholds in ms, as Apdex reads them with its default 500 ms target: up to the target
 * is satisfied, up to four times it tolerated, above that frustrated.
 */
export const LATENCY_SLOW_MS = 500;
export const LATENCY_FRUSTRATED_MS = 2_000;

/**
 * The page's state, all of it in the URL: `?range=`, the timeline's zoom and jump point (#587,
 * `?from=&to=&at=`) and the filters (#586) under their API names.
 */
export interface ExploreState extends ExploreWindow {
  range: QueryRange;
  filters: ExploreFilters;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the page state from search params; anything unknown or invalid falls back to the default. */
export function parseExploreQuery(params: SearchParams): ExploreState {
  const range = first(params.range);
  return { range: EXPLORE_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE, ...parseWindow(params), filters: parseFilters(params) };
}

/**
 * The search string of `q` (with its `?`, or ""), defaults left out, then `w` (the window) and the
 * filters, each in a fixed order.
 */
function exploreSearch(q: Partial<ExploreState>, withRange: boolean, w: ExploreWindow): string {
  const p = new URLSearchParams();
  if (q.range && (withRange || q.range !== DEFAULT_RANGE)) p.set("range", q.range);
  for (const [k, v] of windowEntries(w)) p.set(k, v);
  for (const [k, v] of filterEntries(q.filters ?? NO_FILTERS)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The page URL for `q`, leaving defaults out. */
export function exploreHref(project: string, q: Partial<ExploreState>): string {
  return `/${encodeURIComponent(project)}/explore${exploreSearch(q, false, q)}`;
}

/**
 * The Route Handler the browser polls: `GET /api/projects/{slug}/requests?range=&from=&to=&<filters>`,
 * the window being the zoom with its end pulled in to the jump point.
 */
export function requestsPath(project: string, q: Pick<ExploreState, "range"> & Partial<ExploreState>): string {
  return `/api/projects/${encodeURIComponent(project)}/requests${exploreSearch(q, true, logWindow(q))}`;
}

/** The timeline's Route Handler (#587): `GET /api/projects/{slug}/requests/timeline?range=&from=&to=&<filters>`, the zoom only. */
export function timelinePath(project: string, q: Pick<ExploreState, "range"> & Partial<ExploreState>): string {
  return `/api/projects/${encodeURIComponent(project)}/requests/timeline${exploreSearch(q, true, chartWindow(q))}`;
}

/**
 * The scope in words: `the last 1 hour`; `the window from 10:02 to 10:14 UTC` when zoomed;
 * `…, up to 10:10 UTC` after a jump.
 */
export function scopeText(q: Pick<ExploreState, "range"> & ExploreWindow): string {
  const base = q.from && q.to ? `the window from ${windowText(q.from, q.to)}` : `the last ${RANGE_LABEL[q.range]}`;
  return q.at ? `${base}, up to ${instantText(q.at)}` : base;
}

/** A stable key for a row: its trace id (one request row per trace), else its time and position. */
export const rowKey = (r: Pick<RequestRow, "timestamp" | "trace_id">, i: number) => r.trace_id || `${r.timestamp}#${i}`;

/** The status class of a response code, for the chip: 4xx warn, 5xx error, the rest neutral. */
export function statusClass(code: number): "2xx" | "3xx" | "4xx" | "5xx" | "other" {
  if (code >= 600 || code < 100) return "other";
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  if (code >= 200) return "2xx";
  return "other";
}

/** How a latency reads against the thresholds. */
export function latencyTone(ms: number): "ok" | "slow" | "frustrated" {
  if (ms > LATENCY_FRUSTRATED_MS) return "frustrated";
  if (ms > LATENCY_SLOW_MS) return "slow";
  return "ok";
}

/** A body size in bytes: `0 B`, `512 B`, `1.2 KB`, `14 KB`, `3.4 MB`. Unknown sizes read as a dash. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "–";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1000;
  let u = 0;
  while (v >= 999.5 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Who made the request: the consumer's name, else its id, else null when it was anonymous. */
export function consumerOf(r: Pick<RequestRow, "consumer_id" | "consumer_name">): string | null {
  return (r.consumer_name ?? "").trim() || (r.consumer_id ?? "").trim() || null;
}

/** True when the SDK sampled the request out: a base record without headers or bodies. */
export const isSampledOut = (r: Pick<RequestRow, "sampled">) => r.sampled === false;

/**
 * The rows to render for a viewport: `start` (inclusive) to `end` (exclusive), padded by
 * `overscan` on both sides and clamped to `count`. Before layout (`viewport` 0) it renders one
 * screen's worth from the top, so the server's first paint already has rows.
 */
export function visibleWindow(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const height = viewport > 0 ? viewport : 20 * rowHeight;
  const top = Math.max(0, scrollTop);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  const start = Math.min(Math.max(0, Math.floor(top / rowHeight) - overscan), end);
  return { start, end };
}

/**
 * The row index a key moves focus to from `current`, or null for keys the log leaves alone (so
 * ⌘K, Tab and the rest keep working). `page` is how many rows fit in the viewport.
 */
export function moveFocus(key: string, current: number, count: number, page: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const step = Math.max(1, page - 1);
  switch (key) {
    case "ArrowDown":
      return Math.min(last, current + 1);
    case "ArrowUp":
      return Math.max(0, current - 1);
    case "PageDown":
      return Math.min(last, current + step);
    case "PageUp":
      return Math.max(0, current - step);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** One poll of the Route Handler, as the log cares. */
export type LogPoll = { kind: "rows"; rows: RequestRow[] } | { kind: "expired"; next: string } | { kind: "error"; code: string };

/** Reads the Route Handler's answer (`{ok: true, requests}` or `{ok: false, code, next?}`). */
export function logPoll(status: number, body: unknown): LogPoll {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.ok === true) return { kind: "rows", rows: Array.isArray(b.requests) ? (b.requests as RequestRow[]) : [] };
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  return { kind: "error", code };
}

export const LOG_LOAD_FAILED = "We couldn’t load requests just now.";
export const LOG_POLL_FAILED = "Couldn’t refresh the log. These are the last rows we read; we keep trying.";
