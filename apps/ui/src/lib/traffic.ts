// The Traffic page (#592): requests, errors and latency of a project over a range and an
// environment, a status-split timeseries and the endpoints table. Pure helpers (URL state,
// formatting, chart geometry), unit-tested in traffic.test.ts.
import { RANGE_LABEL, niceMax } from "./consumers";
import type { EndpointTraffic, QueryRange, TrafficPoint } from "./identity";

export const TRAFFIC_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: QueryRange = "24h";
/** How many endpoints the table asks for (the API's largest page); the table pages them. */
export const ENDPOINTS_LIMIT = 500;
/** How often the page reads again while live. */
export const LIVE_INTERVAL_MS = 30_000;
/** The longest environment name the API takes. */
const MAX_ENV = 64;

/** The page's state, all of it in the URL: `?range=&env=`. An empty env means all environments. */
export interface TrafficState {
  range: QueryRange;
  env: string;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parseTrafficQuery(params: SearchParams): TrafficState {
  const range = first(params.range);
  const env = (first(params.env) ?? "").trim();
  return {
    range: TRAFFIC_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: env.length <= MAX_ENV ? env : "",
  };
}

function scopeParams(q: Partial<TrafficState>): string {
  const p = new URLSearchParams();
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.env) p.set("env", q.env);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The page URL for `q`, leaving defaults out. */
export function trafficHref(project: string, q: Partial<TrafficState>): string {
  return `/${encodeURIComponent(project)}/traffic${scopeParams(q)}`;
}

/** An endpoint's detail page (`/<project>/endpoints/<method>/<path>`, #593), keeping the scope. */
export function endpointHref(project: string, ep: Pick<EndpointTraffic, "method" | "path">, q: Partial<TrafficState>): string {
  return `/${encodeURIComponent(project)}/endpoints/${encodeURIComponent(ep.method.toUpperCase())}/${encodeURIComponent(ep.path)}${scopeParams(q)}`;
}

/** The scope in words, for empty states and chart summaries: `the last 24 hours in production`. */
export function scopeText(q: TrafficState): string {
  return `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}`;
}

/** A latency in milliseconds: `<1 ms`, `42 ms`, `1.24 s`, `12.5 s`. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1) return "<1 ms";
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
}

/** An Apdex score with two decimals; `n/a` when there were no requests to score. */
export function formatApdex(apdex: number | null | undefined): string {
  if (apdex === null || apdex === undefined || !Number.isFinite(apdex)) return "n/a";
  return Math.min(1, Math.max(0, apdex)).toFixed(2);
}

/** The standard Apdex rating band of a score, or null without one. */
export function apdexRating(apdex: number | null | undefined): string | null {
  if (apdex === null || apdex === undefined || !Number.isFinite(apdex)) return null;
  if (apdex >= 0.94) return "Excellent";
  if (apdex >= 0.85) return "Good";
  if (apdex >= 0.7) return "Fair";
  if (apdex >= 0.5) return "Poor";
  return "Unacceptable";
}

/** A timeseries bucket split by status class for the stacked chart: successful, 4xx, 5xx. */
export interface StatusRow {
  ts: string;
  successful: number;
  client_errors: number;
  server_errors: number;
}

export function statusRows(points: readonly TrafficPoint[]): StatusRow[] {
  return points.map((p) => ({
    ts: p.ts,
    successful: Math.max(0, p.requests - p.client_errors - p.server_errors),
    client_errors: p.client_errors,
    server_errors: p.server_errors,
  }));
}

/**
 * The plot width to draw at: the measured width of the chart's box, or null while it is not
 * known (server render, before layout) or reported as zero or negative (a hidden or detached box:
 * the v1 recharts `width(-1)` race). With null the chart draws at its fixed viewBox, stretched to
 * the box by CSS, so it is never blank while it waits for a measurement.
 */
export function plotWidth(measured: number | null | undefined): number | null {
  if (measured === null || measured === undefined || !Number.isFinite(measured) || measured < 1) return null;
  return Math.round(measured);
}

/**
 * The `d` of an SVG path drawing `values` as a line in a `width` × `height` box, one point at the
 * centre of each bucket, scaled against `top` (0 at the baseline). Empty without values.
 */
export function linePath(values: readonly number[], width: number, height: number, top: number): string {
  if (values.length === 0) return "";
  const slot = width / values.length;
  return values.map((v, i) => `${i === 0 ? "M" : "L"}${round(i * slot + slot / 2)},${round(lineY(v, height, top))}`).join("");
}

/** The y where linePath draws `v` in a box `height` tall scaled against `top` (clamped to the box). */
export function lineY(v: number, height: number, top: number): number {
  const max = top > 0 ? top : 1;
  const n = Number.isFinite(v) ? v : 0;
  return height - (Math.max(0, Math.min(n, max)) / max) * height;
}

/** A round axis top for latencies in ms. */
export const latencyTop = (values: readonly number[]) => niceMax(Math.max(0, ...values));

const round = (n: number) => Math.round(n * 10) / 10;

export const TRAFFIC_LOAD_FAILED = "We couldn’t load traffic just now.";
export const TIMESERIES_LOAD_FAILED = "We couldn’t load traffic over time just now.";
export const ENDPOINTS_LOAD_FAILED = "We couldn’t load endpoints just now.";
