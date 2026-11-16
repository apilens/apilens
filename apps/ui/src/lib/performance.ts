// The Performance page (#595): response times of a project over a range and an environment,
// its Apdex, the response-time histogram, the endpoints by p95 and the app-wide response time
// threshold. Pure helpers (URL state, sorting, threshold input), unit-tested in performance.test.ts.
import { RANGE_LABEL } from "./consumers";
import type { AppSettings, EndpointTraffic, QueryRange } from "./identity";
import { DEFAULT_RANGE, TRAFFIC_RANGES, endpointHref } from "./traffic";

/** The Apdex threshold T when neither the endpoint nor its app sets one, in ms. */
export const DEFAULT_THRESHOLD_MS = 500;
/** The threshold range the API takes, in ms. */
export const MAX_APP_THRESHOLD_MS = 600_000;
/** How many endpoints the table asks for (the API's largest page). */
export const PERF_ENDPOINTS_LIMIT = 500;

/** The longest environment name and app slug the API takes. */
const MAX_ENV = 64;
const MAX_APP = 63;

/**
 * The page's state, all of it in the URL: `?range=&env=&app=`. An empty env means all
 * environments; `app` picks the app whose threshold the settings dialog edits (else the first).
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
    app: capped(params.app, MAX_APP),
  };
}

/** The page URL for `q`, leaving defaults out. */
export function performanceHref(project: string, q: Partial<PerformanceState>): string {
  const p = new URLSearchParams();
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.env) p.set("env", q.env);
  if (q.app) p.set("app", q.app);
  const s = p.toString();
  return `/${encodeURIComponent(project)}/performance${s ? `?${s}` : ""}`;
}

/** An endpoint's Response times tab, keeping the range and environment. */
export function endpointLatencyHref(project: string, ep: Pick<EndpointTraffic, "method" | "path">, q: PerformanceState): string {
  const href = endpointHref(project, ep, { range: q.range, env: q.env });
  return `${href}${href.includes("?") ? "&" : "?"}tab=latency`;
}

/** The scope in words: `the last 24 hours in production`. */
export function perfScopeText(q: PerformanceState): string {
  return `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}`;
}

/**
 * Endpoints with requests, slowest p95 first (ties: more requests first, then by path). Routes
 * listed without traffic have no response times to rank, so they are left out.
 */
export function byP95(endpoints: readonly EndpointTraffic[]): EndpointTraffic[] {
  return endpoints
    .filter((e) => e.requests > 0)
    .sort((a, b) => b.p95_ms - a.p95_ms || b.requests - a.requests || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
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
    "Apdex scores response times from 0 (all frustrated) to 1 (all satisfied) against a threshold T.",
    "Satisfied: answered within T. Tolerating: within 4T. Frustrated: slower than 4T.",
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

export const PERFORMANCE_LOAD_FAILED = "We couldn’t load response times just now.";
export const PERF_ENDPOINTS_LOAD_FAILED = "We couldn’t load endpoints just now.";
