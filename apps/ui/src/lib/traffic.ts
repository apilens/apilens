// The Traffic page (#592): requests, errors and latency of a project over a range and an
// environment, a status-split timeseries and the endpoints table. Pure helpers (URL state,
// formatting, chart geometry), unit-tested in traffic.test.ts.
import { isAppId } from "./capture-policy";
import { RANGE_LABEL, niceMax } from "./consumers";
import type { EndpointTraffic, NamedApp, QueryRange, TrafficPoint } from "./identity";
import { envParam } from "./scope-defaults";

export const TRAFFIC_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: QueryRange = "24h";
/** How many endpoints the table asks for (the API's largest page); the table pages them. */
export const ENDPOINTS_LIMIT = 500;
/** How often the page reads again while live. */
export const LIVE_INTERVAL_MS = 30_000;
/** The longest environment name the API takes. */
const MAX_ENV = 64;

/**
 * The page's state, all of it in the URL: `?range=&env=&app=`. An empty env means all
 * environments; an empty app (an app id, #976) means all apps.
 */
export interface TrafficState {
  range: QueryRange;
  env: string;
  app: string;
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
    app: parseAppParam(params.app),
  };
}

/** A page's `?app=` (#976): an app id, lower-cased, else "" for all apps. */
export function parseAppParam(v: string | string[] | undefined): string {
  const app = (first(v) ?? "").trim();
  return isAppId(app) ? app.toLowerCase() : "";
}

/**
 * The app filter's options (#976): All apps first, then the project's apps. A shared link may name
 * an app the project no longer lists; it stays selectable as an unknown app, so the picker never
 * names a different scope than the one read.
 */
export function appOptions(apps: readonly NamedApp[], current: string): { value: string; label: string }[] {
  const options = [{ value: "", label: "All apps" }, ...apps.map((a) => ({ value: a.id, label: a.name }))];
  if (current && !apps.some((a) => a.id === current)) options.push({ value: current, label: "Unknown app" });
  return options;
}

/** The name of app `id` among `apps`, for the App column and the scope in words. */
export function appName(apps: readonly NamedApp[] | null | undefined, id: string): string {
  return apps?.find((a) => a.id === id)?.name ?? "Unknown app";
}

function scopeParams(q: Partial<TrafficState>): string {
  const p = new URLSearchParams();
  if (q.range) p.set("range", q.range);
  if (q.env !== undefined) p.set("env", envParam(q.env));
  if (q.app) p.set("app", q.app);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The page URL for `q`, leaving defaults out; a range and env always go in, a URL without them reads the smart defaults (#993). */
export function trafficHref(project: string, q: Partial<TrafficState>): string {
  return `/${encodeURIComponent(project)}/traffic${scopeParams(q)}`;
}

/**
 * An endpoint's detail page (`/<project>/endpoints/<method>/<path>`, #593), keeping the scope; with
 * `app` it opens scoped to that app (a Traffic row is one app's endpoint, #976).
 */
export function endpointHref(project: string, ep: Pick<EndpointTraffic, "method" | "path">, q: Partial<TrafficState>): string {
  return `/${encodeURIComponent(project)}/endpoints/${encodeURIComponent(ep.method.toUpperCase())}/${encodeURIComponent(ep.path)}${scopeParams(q)}`;
}

/**
 * The scope in words, for empty states and chart summaries: `the last 24 hours in production`,
 * then `for Billing` when one app is in scope (`appLabel` is its name).
 */
export function scopeText(q: Pick<TrafficState, "range" | "env"> & { app?: string }, appLabel?: string): string {
  return `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}${q.app && appLabel ? ` for ${appLabel}` : ""}`;
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

// Endpoints table sort (#1001) ------------------------------------------------------------------

/** The columns the endpoints table sorts by, as `?sort=` names them. */
export const ENDPOINT_SORT_KEYS = ["endpoint", "app", "requests", "client_errors", "server_errors", "p50", "p95", "apdex"] as const;
export type EndpointSortKey = (typeof ENDPOINT_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export interface EndpointSort {
  key: EndpointSortKey;
  dir: SortDir;
}

/** The table's order without `?sort=`: busiest first, as the API lists them. */
export const DEFAULT_ENDPOINT_SORT: EndpointSort = { key: "requests", dir: "desc" };

/** Which way a column sorts first: names A to Z, numbers largest (or, for Apdex, worst) first. */
export function firstDir(key: EndpointSortKey): SortDir {
  return key === "endpoint" || key === "app" || key === "apdex" ? "asc" : "desc";
}

/** Reads `?sort=&dir=`; an unknown column is the default order, an unknown direction the column's first. */
export function parseEndpointSort(params: SearchParams): EndpointSort {
  const key = first(params.sort);
  if (!ENDPOINT_SORT_KEYS.includes(key as EndpointSortKey)) return DEFAULT_ENDPOINT_SORT;
  const dir = first(params.dir);
  return { key: key as EndpointSortKey, dir: dir === "asc" || dir === "desc" ? dir : firstDir(key as EndpointSortKey) };
}

/**
 * The `?sort=&dir=` a column header links to: the column in its first direction, or the other way
 * when it is already the order. The default order leaves both out.
 */
export function nextEndpointSort(current: EndpointSort, key: EndpointSortKey): { sort: string | null; dir: string | null } {
  const dir: SortDir = current.key === key ? (current.dir === "asc" ? "desc" : "asc") : firstDir(key);
  if (key === DEFAULT_ENDPOINT_SORT.key && dir === DEFAULT_ENDPOINT_SORT.dir) return { sort: null, dir: null };
  return { sort: key, dir };
}

/** A header's `aria-sort`: its direction when it is the order, else none. */
export function ariaSort(current: EndpointSort, key: EndpointSortKey): "ascending" | "descending" | undefined {
  if (current.key !== key) return undefined;
  return current.dir === "asc" ? "ascending" : "descending";
}

/**
 * The endpoints in `sort` order; ties keep the API's order (busiest first). An endpoint without an
 * Apdex (no requests) sorts last either way; `appLabel` names a row's app for the App column.
 */
export function sortEndpoints(endpoints: readonly EndpointTraffic[], sort: EndpointSort, appLabel: (id: string) => string = (id) => id): EndpointTraffic[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (e: EndpointTraffic): number | string | null => {
    switch (sort.key) {
      case "endpoint":
        return `${e.path} ${e.method.toUpperCase()}`;
      case "app":
        return appLabel(e.app_id);
      case "requests":
        return e.requests;
      case "client_errors":
        return e.client_errors;
      case "server_errors":
        return e.server_errors;
      case "p50":
        return e.p50_ms;
      case "p95":
        return e.p95_ms;
      case "apdex":
        return e.apdex === null || e.apdex === undefined || !Number.isFinite(e.apdex) ? null : e.apdex;
    }
  };
  return endpoints
    .map((e, i) => ({ e, i, v: value(e) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const c = typeof a.v === "string" ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.e);
}

// Declared routes and path search (#1003) ---------------------------------------------------------

/** The longest path search the table takes. */
export const MAX_ENDPOINT_SEARCH = 200;

/** Reads the endpoints table's path search, `?q=`: trimmed, "" for none. */
export function parseEndpointSearch(params: SearchParams): string {
  return (first(params.q) ?? "").trim().slice(0, MAX_ENDPOINT_SEARCH);
}

/**
 * The endpoints whose path (or `METHOD path`) contains `search`, ignoring case; every endpoint
 * without a search.
 */
export function searchEndpoints(endpoints: readonly EndpointTraffic[], search: string): EndpointTraffic[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...endpoints];
  return endpoints.filter((e) => `${e.method.toUpperCase()} ${e.path}`.toLowerCase().includes(needle));
}

/**
 * The endpoints with traffic apart from the routes an app declared without any (`discovered_only`):
 * those have zero counts, so the table would show them like fast endpoints; they are listed on
 * their own instead.
 */
export function splitDeclared(endpoints: readonly EndpointTraffic[]): { active: EndpointTraffic[]; declared: EndpointTraffic[] } {
  const active: EndpointTraffic[] = [];
  const declared: EndpointTraffic[] = [];
  for (const e of endpoints) (e.discovered_only ? declared : active).push(e);
  return { active, declared };
}

/** `3 declared routes without traffic`, `1 declared route without traffic`. */
export function declaredLabel(n: number): string {
  return `${n.toLocaleString("en-US")} declared ${n === 1 ? "route" : "routes"} without traffic`;
}

export const TRAFFIC_LOAD_FAILED ="We couldn’t load traffic just now.";
export const TIMESERIES_LOAD_FAILED = "We couldn’t load traffic over time just now.";
export const ENDPOINTS_LOAD_FAILED = "We couldn’t load endpoints just now.";
