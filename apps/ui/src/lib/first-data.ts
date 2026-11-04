// "Your first requests" onboarding step (#335): what it loads from the query API as the signed-in
// user (`GET /requests`, `/traffic/summary` and `/traffic/endpoints` with `?project=`, #295) and
// how it shows it. Pure, so the formatting and the load's error handling can be unit tested.
import type { EndpointTraffic, QueryRange, RequestRow, TrafficSummary } from "./identity";

/** The window the screen reads: wide enough that a user coming back days later still sees their traffic. */
export const FIRST_DATA_RANGE: QueryRange = "7d";
/** The latest requests the table shows. */
export const FIRST_DATA_ROWS = 10;
/** The most endpoints counted; at the limit the count reads "500+". */
export const ENDPOINT_LIMIT = 500;

/** What the screen shows. */
export interface FirstData {
  /** Newest first, at most {@link FIRST_DATA_ROWS}. */
  requests: RequestRow[];
  /** Requests in the window. */
  total: number;
  /** Endpoints (method and route template) seen in the window. */
  endpoints: number;
  /** p95 latency over the window; null without requests. */
  p95Ms: number | null;
}

/** The three answers, combined. */
export function firstData(
  requests: { requests: RequestRow[] | null },
  summary: TrafficSummary,
  endpoints: { endpoints: EndpointTraffic[] | null },
): FirstData {
  const rows = (requests.requests ?? []).slice(0, FIRST_DATA_ROWS);
  // The summary reads the rollups and the table the raw rows: never show fewer requests than rows.
  const total = Math.max(summary.requests ?? 0, rows.length);
  return {
    requests: rows,
    total,
    endpoints: (endpoints.endpoints ?? []).length,
    p95Ms: total > 0 && Number.isFinite(summary.p95_ms) ? summary.p95_ms : null,
  };
}

/** Loads the three answers at once; any failure fails the load (the screen offers a retry). */
export async function loadFirstData(load: {
  requests: () => Promise<{ requests: RequestRow[] | null }>;
  summary: () => Promise<TrafficSummary>;
  endpoints: () => Promise<{ endpoints: EndpointTraffic[] | null }>;
}): Promise<FirstData> {
  const [requests, summary, endpoints] = await Promise.all([load.requests(), load.summary(), load.endpoints()]);
  return firstData(requests, summary, endpoints);
}

/** The endpoint count, "500+" at the limit. */
export function endpointCount(n: number): string {
  return n >= ENDPOINT_LIMIT ? `${ENDPOINT_LIMIT}+` : String(n);
}

/** A latency: "<1 ms", "38 ms", "1.24 s". */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** A count with thousands separators. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** How long ago `at` was, from `now`: "just now", "42s ago", "3m ago", "2h ago", "4d ago". */
export function formatAgo(at: string, now: number): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The status tone of a response code: 5xx error, 4xx warn, else ok. */
export function statusTone(code: number): "ok" | "warn" | "error" {
  if (code >= 500) return "error";
  if (code >= 400) return "warn";
  return "ok";
}

/** The path to show for a row: the URL as requested when there is one, else the route template. */
export function shownPath(row: Pick<RequestRow, "path" | "raw_path">): string {
  return row.raw_path || row.path;
}

/** The message when the requests could not be loaded. */
export const LOAD_FAILED = "We couldn’t load your requests just now.";
