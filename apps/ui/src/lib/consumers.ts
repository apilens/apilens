// The Consumers page (#596): who calls the project's API, new vs returning, per-consumer traffic
// with a sparkline, one consumer's requests and errors, and consumer groups. Pure helpers (URL
// state, chart geometry, group roll-ups, copy), unit-tested in consumers.test.ts.
import type { ConsumerGroup, ConsumerRow, QueryRange, StatusSplit } from "./identity";

export const CONSUMER_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: QueryRange = "24h";
export const RANGE_LABEL: Record<QueryRange, string> = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days" };

/** How many consumers the individual list asks for, and the groups roll-up (it sums them). */
export const LIST_LIMIT = 100;
export const GROUPS_LIMIT = 500;
export const MAX_GROUP_NAME = 128;

export type ConsumersBy = "consumers" | "groups";
export type DetailTab = "requests" | "errors";

/** The page's state, all of it in the URL: `?range=&by=&group=&consumer=&tab=`. */
export interface ConsumersQuery {
  range: QueryRange;
  by: ConsumersBy;
  /** A consumer group id the list is filtered to, or null. */
  group: string | null;
  /** The consumer whose detail is open, or null. */
  consumer: string | null;
  tab: DetailTab;
}

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parseConsumersQuery(params: SearchParams): ConsumersQuery {
  const range = first(params.range);
  const group = first(params.group);
  const consumer = first(params.consumer);
  return {
    range: CONSUMER_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    by: first(params.by) === "groups" ? "groups" : "consumers",
    group: group && UUID.test(group) ? group.toLowerCase() : null,
    consumer: consumer && consumer.length <= 256 ? consumer : null,
    tab: first(params.tab) === "errors" ? "errors" : "requests",
  };
}

/** The page URL for `q`, leaving defaults out. */
export function consumersHref(project: string, q: Partial<ConsumersQuery>): string {
  const p = new URLSearchParams();
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.by === "groups") p.set("by", "groups");
  if (q.group && q.by !== "groups") p.set("group", q.group);
  if (q.consumer) {
    p.set("consumer", q.consumer);
    if (q.tab === "errors") p.set("tab", "errors");
  }
  const s = p.toString();
  return `/${encodeURIComponent(project)}/consumers${s ? `?${s}` : ""}`;
}

/** What a consumer is called: its reported name, else its id. */
export const consumerLabel = (c: { consumer_id: string; consumer_name: string }) => c.consumer_name.trim() || c.consumer_id;

export const errorsOf = (s: Pick<StatusSplit, "client_errors" | "server_errors">) => s.client_errors + s.server_errors;

/** An error rate (0..1) as a percentage: `0%`, `<0.1%`, `2.4%`. */
export function formatRate(errors: number, requests: number): string {
  if (requests <= 0 || errors <= 0) return "0%";
  const rate = errors / requests;
  if (rate < 0.001) return "<0.1%";
  return `${(rate * 100).toFixed(1)}%`;
}

const COUNT = new Intl.NumberFormat("en-US");
export const formatCount = (n: number) => COUNT.format(n);

/** Requests per minute: `0`, `<0.1`, `2.4`, `310`. */
export function formatPerMinute(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 0.1) return "<0.1";
  if (n < 100) return n.toFixed(1);
  return COUNT.format(Math.round(n));
}

const BUCKET_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const BUCKET_TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

/** A bucket's start for tooltips and axis labels, in UTC: `14:05 UTC` or `Nov 5, 14:00 UTC`. */
export function formatBucket(ts: string, range: QueryRange): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  return `${(range === "7d" || range === "24h" ? BUCKET_DAY : BUCKET_TIME).format(t)} UTC`;
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

/** A consumer group with the traffic of its consumers in the list. */
export interface GroupRollup extends StatusSplit {
  group: ConsumerGroup;
  /** Consumers of the group seen in the range (among the listed ones). */
  active: number;
  sparkline: number[];
}

/** Sums the listed consumers' traffic per group, groups in their given order. */
export function rollupGroups(groups: readonly ConsumerGroup[], consumers: readonly ConsumerRow[]): GroupRollup[] {
  const by = new Map<string, GroupRollup>(
    groups.map((group) => [group.id, { group, active: 0, requests: 0, successful: 0, client_errors: 0, server_errors: 0, sparkline: [] }]),
  );
  for (const c of consumers) {
    const g = c.group ? by.get(c.group.id) : undefined;
    if (!g) continue;
    g.active += 1;
    g.requests += c.requests;
    g.successful += c.successful;
    g.client_errors += c.client_errors;
    g.server_errors += c.server_errors;
    (c.sparkline ?? []).forEach((v, i) => {
      g.sparkline[i] = (g.sparkline[i] ?? 0) + v;
    });
  }
  return [...by.values()];
}

/** The group name as it will be saved, or why it cannot be. */
export function checkGroupName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return { ok: false, error: "Enter a name for the group." };
  if ([...name].length > MAX_GROUP_NAME) return { ok: false, error: `Use at most ${MAX_GROUP_NAME} characters.` };
  return { ok: true, name };
}

/** A sentence for a failed group change, by API error code. */
export function groupError(code: string): string {
  switch (code) {
    case "conflict":
      return "This project already has a group with that name.";
    case "validation_failed":
    case "bad_request":
    case "invalid_request":
      return `Use a name of 1 to ${MAX_GROUP_NAME} characters.`;
    case "forbidden":
      return "You can’t change consumer groups in this project. Ask a project admin.";
    case "not_found":
      return "That group no longer exists. Reload the page to see the current groups.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

export const CONSUMERS_LOAD_FAILED = "We couldn’t load consumers just now.";
export const CONSUMER_LOAD_FAILED = "We couldn’t load this consumer just now.";
export const GROUPS_LOAD_FAILED = "We couldn’t load consumer groups just now.";
