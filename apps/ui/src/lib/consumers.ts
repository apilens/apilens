// The Consumers page (#596): the users of the project's API (the consumer the SDK identifies on
// each request, usually the customer's own user id), new vs returning, per-user traffic with a
// sparkline, one user's requests and errors, and the groups the SDK reports (`consumer_group`,
// e.g. the company or plan a user belongs to). Groups are never created or assigned here. Pure
// helpers (URL state, chart geometry, copy), unit-tested in consumers.test.ts.
import type { QueryRange, StatusSplit } from "./identity";
import { zoneLabel, zoned } from "./time-zone";
import { projectHref } from "./routes";
import { envParam } from "./scope-defaults";

export const CONSUMER_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: QueryRange = "24h";
export const RANGE_LABEL: Record<QueryRange, string> = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days" };

/** Longest consumer id, group name and search the API takes. */
export const MAX_TEXT = 256;

export type ConsumersBy = "consumers" | "groups" | "anonymous";
export type DetailTab = "requests" | "errors";
export type ConsumerSort = "requests" | "errors" | "last_seen";
export type GroupSort = ConsumerSort | "consumers";
const CONSUMER_SORTS: readonly ConsumerSort[] = ["requests", "errors", "last_seen"];
const GROUP_SORTS: readonly GroupSort[] = ["requests", "errors", "consumers", "last_seen"];

/** The longest environment name the API takes. */
const MAX_ENV = 64;

/**
 * The page's state, all of it in the URL: `?range=&env=&by=&group=&consumer=&tab=&q=&sort=` (plus
 * `page`/`per`). `consumer` opens that user's drawer over the list, which keeps its own filters.
 */
export interface ConsumersQuery {
  range: QueryRange;
  /** An environment the reads are narrowed to; "" for all. */
  env: string;
  by: ConsumersBy;
  /** An SDK consumer group the consumers list is narrowed to, or null. */
  group: string | null;
  /** The consumer whose detail is open, or null. */
  consumer: string | null;
  tab: DetailTab;
  /** Search over consumer ids and names (or group names, by group); "" for none. */
  q: string;
  /** The table's order; `consumers` only applies by group. */
  sort: GroupSort;
}

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const text = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t !== "" && t.length <= MAX_TEXT ? t : null;
};

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parseConsumersQuery(params: SearchParams): ConsumersQuery {
  const range = first(params.range);
  const byParam = first(params.by);
  const by: ConsumersBy = byParam === "groups" || byParam === "anonymous" ? byParam : "consumers";
  const env = (first(params.env) ?? "").trim();
  const sort = first(params.sort);
  const sorts: readonly string[] = by === "groups" ? GROUP_SORTS : CONSUMER_SORTS;
  return {
    range: CONSUMER_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: env.length <= MAX_ENV && env !== "all" ? env : "",
    by,
    group: by === "consumers" ? text(first(params.group)) : null,
    consumer: (() => {
      const c = first(params.consumer);
      return c && c.length <= MAX_TEXT ? c : null;
    })(),
    tab: first(params.tab) === "errors" ? "errors" : "requests",
    q: text(first(params.q)) ?? "",
    sort: sort && sorts.includes(sort) ? (sort as GroupSort) : "requests",
  };
}

/**
 * The page URL for `q`, leaving defaults out (a range always goes in, #993). It never carries `page`: every link built here (a
 * range, view, filter, search, sort or tab change) starts again at page 1. An open consumer
 * (`consumer`, the drawer) keeps the list's own state under it.
 */
export function consumersHref(project: string, q: Partial<ConsumersQuery>): string {
  const p = new URLSearchParams();
  if (q.range) p.set("range", q.range);
  // As Traffic: an env given is always written, "" as `all`, so All environments isn't read as the default (#993).
  if (q.env !== undefined) p.set("env", envParam(q.env));
  if (q.by === "groups" || q.by === "anonymous") p.set("by", q.by);
  if (q.group && (q.by ?? "consumers") === "consumers") p.set("group", q.group);
  if (q.q && q.by !== "anonymous") p.set("q", q.q);
  if (q.sort && q.sort !== "requests" && q.by !== "anonymous" && (q.by === "groups" || q.sort !== "consumers")) p.set("sort", q.sort);
  if (q.consumer) {
    p.set("consumer", q.consumer);
    if (q.tab === "errors") p.set("tab", "errors");
  }
  const s = p.toString();
  return `${projectHref(project, "consumers")}${s ? `?${s}` : ""}`;
}

/** The view of one SDK group: its consumers, in the range. */
export const groupHref = (project: string, group: string, range: QueryRange, env?: string) => consumersHref(project, { range, env, group });

/** What a consumer is called: its reported name, else its id. */
export const consumerLabel = (c: { consumer_id: string; consumer_name: string }) => c.consumer_name.trim() || c.consumer_id;

export const errorsOf = (s: Pick<StatusSplit, "client_errors" | "server_errors">) => s.client_errors + s.server_errors;

const COUNT = new Intl.NumberFormat("en-US");
export const formatCount = (n: number) => COUNT.format(n);

/** Requests per minute: `0`, `<0.1`, `2.4`, `310`. */
export function formatPerMinute(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 0.1) return "<0.1";
  if (n < 100) return n.toFixed(1);
  return COUNT.format(Math.round(n));
}

const BUCKET_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const BUCKET_TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** A bucket's start for tooltips and axis labels, in `tz`: `14:05 UTC` or `Nov 5, 14:00 UTC`. */
export function formatBucket(ts: string, range: QueryRange, tz: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  return `${zoned("en-US", range === "7d" || range === "24h" ? BUCKET_DAY : BUCKET_TIME, tz).format(t)} ${zoneLabel(tz, t)}`;
}

/** The start of each of `count` buckets from `from`, `seconds` wide (ISO strings); [] when unknown. */
export function bucketTimes(from: string, seconds: number, count: number): string[] {
  const t = Date.parse(from);
  if (Number.isNaN(t) || !(seconds > 0) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => new Date(t + i * seconds * 1000).toISOString());
}

/** A round axis top at or above `n` (1, 2, 2.5 or 5 times a power of ten); 1 for nothing. */
export function niceMax(n: number): number {
  if (!Number.isFinite(n) || n <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

export interface Segment<K extends string> {
  key: K;
  y: number;
  h: number;
}

export interface Bar<K extends string> {
  index: number;
  x: number;
  w: number;
  total: number;
  segments: Segment<K>[];
}

/**
 * Stacked bars for `rows` in a `width` × `height` box: each row one bar, `keys` stacked from the
 * baseline up in order, a 2px gap between bars and between segments. Zero segments are left out.
 */
export function stackBars<K extends string>(rows: Record<K, number>[], keys: readonly K[], width: number, height: number): { top: number; bars: Bar<K>[] } {
  const totals = rows.map((r) => keys.reduce((sum, k) => sum + Math.max(0, r[k] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const slot = rows.length ? width / rows.length : width;
  const gap = slot > 4 ? 2 : 0;
  const bars = rows.map((r, index) => {
    let y = height;
    const segments: Segment<K>[] = [];
    for (const key of keys) {
      const v = Math.max(0, r[key] ?? 0);
      if (v === 0) continue;
      const full = (v / top) * height;
      // Every later segment sits 2px above the one below it.
      const h = Math.max(1, full - (segments.length ? 2 : 0));
      y -= full;
      segments.push({ key, y, h });
    }
    return { index, x: index * slot + gap / 2, w: Math.max(1, slot - gap), total: totals[index], segments };
  });
  return { top, bars };
}

/** The `points` of an SVG polyline drawing `values` in a `width` × `height` box (baseline at the bottom). */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => (max > 0 ? height - 1 - (v / max) * (height - 2) : height - 1);
  return values.map((v, i) => `${round(i * step)},${round(y(v))}`).join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;

export const CONSUMERS_LOAD_FAILED = "We couldn’t load consumers just now.";
export const CONSUMER_LOAD_FAILED = "We couldn’t load this consumer just now.";
export const GROUPS_LOAD_FAILED = "We couldn’t load consumer groups just now.";
export const ANONYMOUS_LOAD_FAILED = "We couldn’t load anonymous callers just now.";
