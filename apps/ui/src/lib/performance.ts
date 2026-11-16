// The Performance page (#595): response times of a project over a range and an environment,
// its Apdex, the response-time histogram, the slowest requests, where the time goes (#1001) and the
// app-wide response time threshold. Pure helpers (URL state, ranking, threshold input), unit-tested
// in performance.test.ts.
import { RANGE_LABEL } from "./consumers";
import { exploreHref } from "./explore";
import { NO_FILTERS } from "./explore-filters";
import type { AppSettings, EndpointTraffic, QueryRange, RequestRow } from "./identity";
import { envParam } from "./scope-defaults";
import { DEFAULT_RANGE, TRAFFIC_RANGES, endpointHref, formatLatency, parseAppParam } from "./traffic";

/** The Apdex threshold T when neither the endpoint nor its app sets one, in ms. */
export const DEFAULT_THRESHOLD_MS = 500;
/** The threshold range the API takes, in ms. */
export const MAX_APP_THRESHOLD_MS = 600_000;
/** How many endpoints the table asks for (the API's largest page). */
export const PERF_ENDPOINTS_LIMIT = 500;

/** The longest environment name the API takes. */
const MAX_ENV = 64;

/**
 * The page's state, all of it in the URL: `?range=&env=&app=`. An empty env means all
 * environments; an empty app (an app id, #976) means all apps.
 */
export interface PerformanceState {
  range: QueryRange;
  env: string;
  app: string;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const capped = (v: string | string[] | undefined, max: number) => {
  const s = (first(v) ?? "").trim();
  return s.length <= max ? s : "";
};

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parsePerformanceQuery(params: SearchParams): PerformanceState {
  const range = first(params.range);
  return {
    range: TRAFFIC_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: capped(params.env, MAX_ENV),
    app: parseAppParam(params.app),
  };
}

/** The page URL for `q`, leaving defaults out; a range and env always go in, a URL without them reads the smart defaults (#993). */
export function performanceHref(project: string, q: Partial<PerformanceState>): string {
  const p = new URLSearchParams();
  if (q.range) p.set("range", q.range);
  if (q.env !== undefined) p.set("env", envParam(q.env));
  if (q.app) p.set("app", q.app);
  const s = p.toString();
  return `/${encodeURIComponent(project)}/performance${s ? `?${s}` : ""}`;
}

/** An endpoint's Response times tab, keeping the range and environment, scoped to the row's app (#976). */
export function endpointLatencyHref(project: string, ep: Pick<EndpointTraffic, "method" | "path"> & { app_id?: string }, q: PerformanceState): string {
  const href = endpointHref(project, ep, { range: q.range, env: q.env, app: ep.app_id || q.app });
  return `${href}${href.includes("?") ? "&" : "?"}tab=latency`;
}

/** The scope in words: `the last 24 hours in production`, then `for Billing` with one app in scope. */
export function perfScopeText(q: PerformanceState, appLabel?: string): string {
  return `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}${q.app && appLabel ? ` for ${appLabel}` : ""}`;
}

/** How many requests the Slowest requests list shows (#1001). */
export const SLOWEST_LIMIT = 10;
/** How many endpoints the Time spent ranking shows (#1001). */
export const TIME_SPENT_LIMIT = 10;

/** One endpoint in the Time spent ranking: its total response time, average and share of the scope's. */
export interface TimeSpentRow {
  endpoint: EndpointTraffic;
  /** Sum of its requests' response times (requests × average), in ms. */
  totalMs: number;
  avgMs: number;
  /** Its part of the time of every endpoint with requests, 0 to 1. */
  share: number;
}

/**
 * Where the API spends its time (#1001): endpoints by total response time (requests × average),
 * most first (ties: more requests first, then by path), the first `limit`. An endpoint without
 * requests has no time to rank, so it is left out; the share is of every endpoint's time, not just
 * the listed ones.
 */
export function byTimeSpent(endpoints: readonly EndpointTraffic[], limit = TIME_SPENT_LIMIT): TimeSpentRow[] {
  const rows = endpoints
    .filter((e) => e.requests > 0 && (e.total_time_ms ?? 0) > 0)
    .map((e) => ({ endpoint: e, totalMs: e.total_time_ms ?? 0, avgMs: (e.total_time_ms ?? 0) / e.requests }));
  const total = rows.reduce((n, r) => n + r.totalMs, 0);
  return rows
    .sort((a, b) => b.totalMs - a.totalMs || b.endpoint.requests - a.endpoint.requests || a.endpoint.path.localeCompare(b.endpoint.path) || a.endpoint.method.localeCompare(b.endpoint.method))
    .slice(0, limit)
    .map((r) => ({ ...r, share: r.totalMs / total }));
}

/** A total time in ms, for Time spent: `840 ms`, `12.4 s`, `3.5 min`, `2.1 h`. */
export function formatTimeSpent(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return formatLatency(ms);
  const min = ms / 60_000;
  if (min < 59.95) return `${min.toFixed(1)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

/**
 * Where a slow request opens (#1001): Explore narrowed to its environment, endpoint and response
 * time or slower, so it heads the list, with `?request=` naming it for the request permalink (#987).
 */
export function slowRequestHref(
  project: string,
  r: Pick<RequestRow, "id" | "environment" | "method" | "path" | "response_time_ms">,
  q: Pick<PerformanceState, "range">,
): string {
  const href = exploreHref(project, {
    range: q.range,
    filters: { ...NO_FILTERS, env: r.environment, method: r.method.toUpperCase(), path: r.path, latency_min: Math.floor(r.response_time_ms) },
  });
  return r.id ? `${href}${href.includes("?") ? "&" : "?"}request=${encodeURIComponent(r.id)}` : href;
}

/**
 * Where an Apdex score sits on the gauge, 0 to 100 (percent of its width); null without a score.
 */
export function apdexPosition(apdex: number | null | undefined): number | null {
  if (apdex === null || apdex === undefined || !Number.isFinite(apdex)) return null;
  return Math.round(Math.min(1, Math.max(0, apdex)) * 1000) / 10;
}

/** The standard Apdex bands on the gauge, from the bottom: where each starts and its rating. */
export const APDEX_BANDS: readonly { from: number; to: number; label: string }[] = [
  { from: 0, to: 0.5, label: "Unacceptable" },
  { from: 0.5, to: 0.7, label: "Poor" },
  { from: 0.7, to: 0.85, label: "Fair" },
  { from: 0.85, to: 0.94, label: "Good" },
  { from: 0.94, to: 1, label: "Excellent" },
];

/** The band a score from 0 to 1 falls in (a band's `to` belongs to the next band; 1 is Excellent). */
export function apdexBandAt(v: number): (typeof APDEX_BANDS)[number] {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return APDEX_BANDS.find((b) => x >= b.from && x < b.to) ?? APDEX_BANDS[APDEX_BANDS.length - 1];
}

/** A band's span as the gauge tooltip writes it: `0.85–0.94`. */
export const apdexBandRange = (b: { from: number; to: number }) => `${b.from.toFixed(2)}–${b.to.toFixed(2)}`;

/**
 * How Apdex is scored, for the explanation tooltip: the formula, then where T comes from, naming
 * the app in scope and its threshold when known.
 */
export function apdexExplanation(app?: { name: string; thresholdMs: number } | null): string[] {
  return [
    "Apdex scores requests from 0 (all frustrated) to 1 (all satisfied) against a response time threshold T.",
    "Satisfied: answered within T. Tolerating: within 4T. Frustrated: slower than 4T, or a server error (5xx) the endpoint does not expect.",
    "Apdex = (satisfied + tolerating / 2) / requests.",
    app
      ? `T is the endpoint’s own threshold, else its app’s (${app.name}: ${app.thresholdMs} ms), else ${DEFAULT_THRESHOLD_MS} ms.`
      : `T is the endpoint’s own threshold, else its app’s, else ${DEFAULT_THRESHOLD_MS} ms.`,
  ];
}

// App threshold --------------------------------------------------------------------------

/** The threshold field as typed: whole milliseconds or empty for the default. */
export function thresholdDraft(s: Pick<AppSettings, "latency_threshold_ms"> | null): string {
  return s?.latency_threshold_ms === null || s?.latency_threshold_ms === undefined ? "" : String(s.latency_threshold_ms);
}

/** Checks the field: whole milliseconds from 1 to 600,000, or empty for the default of 500 ms. */
export function checkThresholdDraft(raw: string): { ok: true; threshold: number | null } | { ok: false; error: string } {
  const v = raw.trim();
  if (!v) return { ok: true, threshold: null };
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!(n >= 1 && n <= MAX_APP_THRESHOLD_MS)) {
    return { ok: false, error: `Enter whole milliseconds from 1 to ${MAX_APP_THRESHOLD_MS.toLocaleString("en-US")}, or leave it empty for the default of ${DEFAULT_THRESHOLD_MS} ms.` };
  }
  return { ok: true, threshold: n };
}

/** Re-checks a threshold coming into the Server Action (a public endpoint). */
export function checkThreshold(value: unknown): { ok: true; threshold: number | null } | { ok: false } {
  if (value === null) return { ok: true, threshold: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_APP_THRESHOLD_MS) return { ok: true, threshold: value };
  return { ok: false };
}

/** A sentence for an API error code when saving the app threshold. */
export function thresholdError(code: string): string {
  switch (code) {
    case "forbidden":
      return "Only project admins can change the response time threshold.";
    case "not_found":
      return "This app no longer exists, or you’re no longer a member of its project.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "That threshold wasn’t accepted. Enter whole milliseconds from 1 to 600,000.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/** A sentence for an API error code when reading an app's threshold for the settings dialog (#976). */
export function loadThresholdError(code: string): string {
  if (code === "forbidden" || code === "invalid_request" || code === "validation_failed" || code === "bad_request") {
    return "We couldn’t load this app’s response time threshold just now. Try again in a moment.";
  }
  return thresholdError(code);
}

export const PERFORMANCE_LOAD_FAILED = "We couldn’t load response times just now.";
export const PERF_ENDPOINTS_LOAD_FAILED = "We couldn’t load endpoints just now.";
export const SLOWEST_LOAD_FAILED = "We couldn’t load the slowest requests just now.";
