// Explore's filter model and URL scheme (#1052, after Supabase Unified Logs): every filter is a
// condition `field · operator · value`, kept in the URL as a repeatable `?filter=field:op:value`
// and sent to the API in the same form. Facets (ticked values) and pills (the filter bar) are two
// views of the same list. Older Explore links (`?status=4xx&app=…`) are translated to it once, on
// load (`legacyConds`). Pure helpers, unit-tested in explore-query.test.ts.
import { normalizeStatus } from "./explore-filters";
import type { QueryRange } from "./identity";
import { isoSecond } from "./explore-timeline";
import { zoneLabel, zonedParts, zoned } from "./time-zone";

export type FieldKey =
  | "path"
  | "status"
  | "method"
  | "app"
  | "env"
  | "consumer"
  | "consumer_group"
  | "url"
  | "ip"
  | "user_agent"
  | "trace_id"
  | "latency"
  | "request_size"
  | "response_size"
  | "payload"
  | "sampled";

export type Op = "eq" | "neq" | "contains" | "ncontains" | "gt" | "lt" | "between";

/** One condition of the filter set. Values are normalised (`parseCond`), so equal ones compare equal. */
export interface Cond {
  field: FieldKey;
  op: Op;
  value: string;
}

export interface FieldDef {
  key: FieldKey;
  label: string;
  ops: readonly Op[];
  /** Monospace values (codes, paths, ids). */
  mono?: boolean;
  placeholder?: string;
  hint?: string;
}

const TEXT_OPS: readonly Op[] = ["eq", "neq", "contains", "ncontains"];
const EQ_OPS: readonly Op[] = ["eq", "neq"];
const NUM_OPS: readonly Op[] = ["gt", "lt", "between"];

/** Every field the filter bar offers, in its menu's order. */
export const FIELDS: readonly FieldDef[] = [
  { key: "path", label: "Path", ops: TEXT_OPS, mono: true, placeholder: "/orders/{id}" },
  { key: "status", label: "Status", ops: EQ_OPS, mono: true, placeholder: "404, 4xx or 500-503", hint: "A code (404), a class (4xx) or a range (500-503)." },
  { key: "method", label: "Method", ops: EQ_OPS, mono: true, placeholder: "GET" },
  { key: "app", label: "App", ops: EQ_OPS },
  { key: "env", label: "Environment", ops: EQ_OPS },
  { key: "consumer", label: "Consumer", ops: TEXT_OPS, placeholder: "A name or an ID" },
  { key: "consumer_group", label: "Consumer group", ops: TEXT_OPS },
  { key: "url", label: "URL", ops: TEXT_OPS, mono: true, placeholder: "?expand=", hint: "The URL as requested, with its query string." },
  { key: "ip", label: "Client IP", ops: TEXT_OPS, mono: true, placeholder: "203.0.113.7" },
  { key: "user_agent", label: "User agent", ops: TEXT_OPS },
  { key: "trace_id", label: "Trace ID", ops: TEXT_OPS, mono: true },
  { key: "latency", label: "Latency", ops: NUM_OPS, mono: true, placeholder: "500", hint: "Milliseconds; a range is 100-500." },
  { key: "request_size", label: "Request size", ops: NUM_OPS, mono: true, placeholder: "1024", hint: "Bytes; a range is 0-1024." },
  { key: "response_size", label: "Response size", ops: NUM_OPS, mono: true, placeholder: "1024", hint: "Bytes; a range is 0-1024." },
  {
    key: "payload",
    label: "Payload",
    ops: ["contains"],
    hint: "Searches request and response bodies, kept only for sampled requests with body capture on.",
  },
  { key: "sampled", label: "Sampling", ops: ["eq"], hint: "true: kept in full; false: sampled out to a base record." },
];

export const fieldDef = (k: FieldKey): FieldDef => FIELDS.find((f) => f.key === k) ?? FIELDS[0];
const isField = (k: string): k is FieldKey => FIELDS.some((f) => f.key === k);

/** How an operator reads in a pill. */
export const OP_LABEL: Record<Op, string> = { eq: "=", neq: "≠", contains: "contains", ncontains: "does not contain", gt: "≥", lt: "≤", between: "between" };
/** How an operator reads to a screen reader. */
export const OP_WORDS: Record<Op, string> = { eq: "is", neq: "is not", contains: "contains", ncontains: "does not contain", gt: "at least", lt: "at most", between: "between" };

/** The most conditions one filter set holds, as the API allows. */
export const MAX_CONDS = 50;
const TEXT_MAX = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHOD_RE = /^[A-Za-z]{1,16}$/;

function num(s: string, whole: boolean): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || (whole && !Number.isSafeInteger(n))) return null;
  return n;
}

/**
 * A value as the field takes it, normalised (status lower case, methods upper case, app ids lower
 * case, ranges `a-b`), or null when the API would refuse it.
 */
export function normalizeValue(field: FieldKey, op: Op, raw: string): string | null {
  const v = raw.trim();
  if (v === "" || v.length > TEXT_MAX) return null;
  switch (field) {
    case "status": {
      const s = normalizeStatus(v);
      return s ? s : null;
    }
    case "method":
      return METHOD_RE.test(v) ? v.toUpperCase() : null;
    case "app":
      return UUID_RE.test(v) ? v.toLowerCase() : null;
    case "env":
      return v.length <= 64 ? v : null;
    case "sampled":
      return v === "true" || v === "false" ? v : null;
    case "latency":
    case "request_size":
    case "response_size": {
      const whole = field !== "latency";
      if (op === "between") {
        const m = v.replace(/\s+/g, "").match(/^(\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)$/);
        if (!m) return null;
        const a = num(m[1], whole);
        const b = num(m[2], whole);
        return a === null || b === null || b < a ? null : `${a}-${b}`;
      }
      const n = num(v, whole);
      return n === null ? null : String(n);
    }
    default:
      return v;
  }
}

/** A condition if `field`, `op` and `raw` make one the API takes, else null. */
export function makeCond(field: string, op: string, raw: string): Cond | null {
  const f = field.trim().toLowerCase();
  if (!isField(f)) return null;
  const o = op.trim().toLowerCase() as Op;
  if (!fieldDef(f).ops.includes(o)) return null;
  const value = normalizeValue(f, o, raw);
  return value === null ? null : { field: f, op: o, value };
}

/** Reads `field:op:value` (the value may hold colons). */
export function parseCond(s: string): Cond | null {
  const i = s.indexOf(":");
  const j = i < 0 ? -1 : s.indexOf(":", i + 1);
  if (i < 0 || j < 0) return null;
  return makeCond(s.slice(0, i), s.slice(i + 1, j), s.slice(j + 1));
}

/** `field:op:value`, as the URL and the API carry a condition. */
export const condString = (c: Cond) => `${c.field}:${c.op}:${c.value}`;
export const sameCond = (a: Cond, b: Cond) => a.field === b.field && a.op === b.op && a.value === b.value;
export const sameConds = (a: readonly Cond[], b: readonly Cond[]) => a.length === b.length && a.every((c, i) => sameCond(c, b[i]));

/** The conditions without repeats, at most MAX_CONDS. */
export function dedupe(conds: readonly Cond[]): Cond[] {
  const out: Cond[] = [];
  for (const c of conds) if (!out.some((x) => sameCond(x, c))) out.push(c);
  return out.slice(0, MAX_CONDS);
}

type SearchParams = Record<string, string | string[] | undefined>;
const all = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const first = (v: string | string[] | undefined) => all(v)[0];

/** The `?filter=` conditions of search params; invalid ones are dropped. */
export function parseConds(params: SearchParams): Cond[] {
  return dedupe(all(params.filter).map(parseCond).filter((c): c is Cond => c !== null));
}

// Older Explore links --------------------------------------------------------------------------

/** The search params older Explore links used for filters, the timeline's jump point and the open request. */
export const LEGACY_KEYS = [
  "env",
  "app",
  "method",
  "status",
  "path",
  "q",
  "url_contains",
  "payload_contains",
  "consumer_id",
  "consumer_group",
  "ip",
  "trace_id",
  "request_size_min",
  "request_size_max",
  "response_size_min",
  "response_size_max",
  "latency_min",
  "latency_max",
  "sampled",
  "at",
  "request",
] as const;

/** Whether search params hold any parameter of the older scheme (the page then rewrites the URL). */
export const hasLegacy = (params: SearchParams) => LEGACY_KEYS.some((k) => params[k] !== undefined);

/**
 * The conditions an older Explore link meant: `?status=4xx,5xx` is two status `=` conditions (any
 * matches), `?latency_min=100&latency_max=500` one `between`, `?q=` (free text) a path `contains`.
 * Values the API would refuse are dropped, as before.
 */
export function legacyConds(params: SearchParams): Cond[] {
  const out: Cond[] = [];
  const add = (field: FieldKey, op: Op, raw: string | undefined) => {
    if (raw === undefined) return;
    const c = makeCond(field, op, raw);
    if (c) out.push(c);
  };
  add("env", "eq", first(params.env));
  add("app", "eq", first(params.app));
  add("method", "eq", first(params.method));
  const status = normalizeStatus(first(params.status) ?? "");
  if (status) for (const t of status.split(",")) add("status", "eq", t);
  add("path", "eq", first(params.path));
  add("path", "contains", first(params.q));
  add("url", "contains", first(params.url_contains));
  add("payload", "contains", first(params.payload_contains));
  add("consumer", "eq", first(params.consumer_id));
  add("consumer_group", "eq", first(params.consumer_group));
  add("ip", "eq", first(params.ip));
  add("trace_id", "eq", first(params.trace_id));
  for (const [field, lo, hi] of [
    ["request_size", "request_size_min", "request_size_max"],
    ["response_size", "response_size_min", "response_size_max"],
    ["latency", "latency_min", "latency_max"],
  ] as const) {
    const a = first(params[lo]);
    const b = first(params[hi]);
    if (a !== undefined && b !== undefined && makeCond(field, "gt", a) && makeCond(field, "lt", b)) add(field, "between", `${a}-${b}`);
    else {
      add(field, "gt", a);
      add(field, "lt", b);
    }
  }
  add("sampled", "eq", first(params.sampled));
  return dedupe(out);
}

// Page state ------------------------------------------------------------------------------------

/** The time ranges Explore offers, each ending now. 15m reads the API's 1h range narrowed by `from`. */
export type ExploreRange = "15m" | "1h" | "6h" | "24h" | "7d";
export const EXPLORE_RANGES: readonly ExploreRange[] = ["15m", "1h", "6h", "24h", "7d"];
export const DEFAULT_RANGE: ExploreRange = "1h";
export const RANGE_MS: Record<ExploreRange, number> = { "15m": 15 * 60_000, "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
export const RANGE_WORDS: Record<ExploreRange, string> = { "15m": "15 minutes", "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days" };
const API_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];
const API_RANGE_MS: Record<QueryRange, number> = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

/**
 * Explore's state, all of it in the URL: a range ending now (`?range=`) or a custom window
 * (`?from=&to=`, either end may be open), the conditions (`?filter=`), and the open request
 * (`?id=`, the detail panel).
 */
export interface ExploreQuery {
  range: ExploreRange;
  from?: string;
  to?: string;
  conds: Cond[];
  id?: string;
}

function timeParam(v: string | undefined): string | undefined {
  if (!v || v.length > 40) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : isoSecond(t);
}

const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Reads the page state from search params, older links included: their filters become conditions
 * after any `?filter=` ones, their jump point (`?at=`) the window's end and their open request
 * (`?request=`) the `?id=`.
 */
export function readExploreUrl(params: SearchParams): ExploreQuery {
  const range = first(params.range);
  const q: ExploreQuery = { range: EXPLORE_RANGES.includes(range as ExploreRange) ? (range as ExploreRange) : DEFAULT_RANGE, conds: [] };
  let from = timeParam(first(params.from));
  let to = timeParam(first(params.to)) ?? timeParam(first(params.at));
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    from = undefined;
    to = undefined;
  }
  if (from) q.from = from;
  if (to) q.to = to;
  q.conds = dedupe([...parseConds(params), ...legacyConds(params)]);
  const id = first(params.id) ?? first(params.request);
  if (id && ID_RE.test(id)) q.id = id;
  return q;
}

/** The search entries of `q`, in a fixed order, defaults left out. */
export function queryEntries(q: Partial<ExploreQuery>): [string, string][] {
  const out: [string, string][] = [];
  if (q.range && q.range !== DEFAULT_RANGE && !q.from && !q.to) out.push(["range", q.range]);
  if (q.from) out.push(["from", q.from]);
  if (q.to) out.push(["to", q.to]);
  for (const c of q.conds ?? []) out.push(["filter", condString(c)]);
  if (q.id) out.push(["id", q.id]);
  return out;
}

const search = (entries: [string, string][]) => {
  const s = new URLSearchParams(entries).toString();
  return s ? `?${s}` : "";
};

/** Explore's URL for `q`. */
export function exploreUrl(project: string, q: Partial<ExploreQuery>): string {
  return `/project/${encodeURIComponent(project)}/explore${search(queryEntries(q))}`;
}

/** Whether the state is a custom window (an end in the past, or a fixed start), not a live range. */
export const isCustom = (q: Pick<ExploreQuery, "from" | "to">) => Boolean(q.from || q.to);

/**
 * The window the API reads for `q` at `now`: the API's range (1h, 6h, 24h or 7d) that holds it,
 * and `from`/`to` inside it. 15m is the last 15 minutes of 1h; a custom window picks the smallest
 * range reaching back to its start (the API clamps anything older to 7 days).
 */
export function apiWindow(q: Pick<ExploreQuery, "range" | "from" | "to">, now: number): { range: QueryRange; from?: string; to?: string } {
  if (!isCustom(q)) {
    if (q.range === "15m") return { range: "1h", from: isoSecond(now - RANGE_MS["15m"]) };
    return { range: q.range };
  }
  const start = q.from ? Date.parse(q.from) : (q.to ? Date.parse(q.to) : now) - RANGE_MS[q.range];
  const reach = now - start;
  const range = API_RANGES.find((r) => reach <= API_RANGE_MS[r]) ?? "7d";
  return { range, ...(q.from ? { from: q.from } : { from: isoSecond(start) }), ...(q.to ? { to: q.to } : {}) };
}

/** The window `q` covers at `now`, in ms. */
export function windowSpan(q: Pick<ExploreQuery, "range" | "from" | "to">, now: number): { start: number; end: number } {
  const end = q.to ? Date.parse(q.to) : now;
  const start = q.from ? Date.parse(q.from) : end - RANGE_MS[q.range];
  return { start, end };
}

/** The timeline's bucket width, as Supabase picks it: minutes under 12 hours, hours under 2 days, days beyond. */
export function bucketFor(q: Pick<ExploreQuery, "range" | "from" | "to">, now: number): "minute" | "hour" | "day" {
  const { start, end } = windowSpan(q, now);
  const span = end - start;
  if (span < 12 * 3_600_000) return "minute";
  if (span < 48 * 3_600_000) return "hour";
  return "day";
}

/** The API query of `q` at `now`: its window and its conditions as `filter` values. */
export function apiQuery(q: Pick<ExploreQuery, "range" | "from" | "to" | "conds">, now: number): { range: QueryRange; from?: string; to?: string; filter: string[] } {
  return { ...apiWindow(q, now), filter: q.conds.map(condString) };
}

/** The search string a Route Handler is called with: the page state (no `?id=`) plus `extra`. */
export function routeSearch(q: Pick<ExploreQuery, "range" | "from" | "to" | "conds">, extra: Record<string, string> = {}): string {
  return search([...queryEntries({ range: q.range === DEFAULT_RANGE ? undefined : q.range, from: q.from, to: q.to, conds: q.conds }), ...Object.entries(extra)]);
}

// Words -----------------------------------------------------------------------------------------

const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** An instant for the range button, in `tz`: `Nov 5, 14:05`. */
export function shortInstant(iso: string, tz: string): string {
  const t = Date.parse(iso);
  return `${zoned("en-US", DAY, tz).format(t)}, ${zoned("en-US", TIME, tz).format(t)}`;
}

/** What the range button says: `Last 1 hour`, or the custom window `Nov 5, 10:00 – 11:00 IST`. */
export function rangeText(q: Pick<ExploreQuery, "range" | "from" | "to">, tz: string): string {
  if (!isCustom(q)) return `Last ${RANGE_WORDS[q.range]}`;
  const end = q.to ? Date.parse(q.to) : Date.now();
  const from = q.from ? shortInstant(q.from, tz) : `${RANGE_WORDS[q.range]} before`;
  const to = q.to ? shortInstant(q.to, tz) : "now";
  return `${from} – ${to} ${zoneLabel(tz, end)}`;
}

/** The time range in a sentence: `the last 1 hour`, `Nov 5, 10:00 – 11:00 IST`. */
export const rangeSentence = (q: Pick<ExploreQuery, "range" | "from" | "to">, tz: string) => (isCustom(q) ? rangeText(q, tz) : `the last ${RANGE_WORDS[q.range]}`);

/** A pill's value as people read it: an app's name, a consumer's name, `100–500 ms`, `2 KB`. */
export function valueText(c: Cond, names: { app?: (id: string) => string | null; consumer?: (id: string) => string | null } = {}): string {
  switch (c.field) {
    case "app":
      return names.app?.(c.value) ?? c.value.slice(0, 8);
    case "consumer":
      return c.op === "eq" || c.op === "neq" ? (names.consumer?.(c.value) ?? c.value) : c.value;
    case "latency":
      return `${c.value.replace("-", "–")} ms`;
    case "request_size":
    case "response_size":
      return `${c.value.replace("-", "–")} B`;
    case "sampled":
      return c.value === "true" ? "kept in full" : "sampled out";
    default:
      return c.value;
  }
}

/** A pill in words, for its label and the screen reader: `Status is 4xx`. */
export function condWords(c: Cond, names?: Parameters<typeof valueText>[1]): string {
  return `${fieldDef(c.field).label} ${OP_WORDS[c.op]} ${valueText(c, names)}`;
}

// Facets ----------------------------------------------------------------------------------------

/** The fields the facet sidebar lists, in its order. */
export const FACET_FIELDS = ["status", "app", "env", "method", "path", "consumer", "consumer_group"] as const;
export type FacetField = (typeof FACET_FIELDS)[number];

/** The values of `field` ticked in the facets: its `=` conditions. */
export const ticked = (conds: readonly Cond[], field: FieldKey): string[] => conds.filter((c) => c.field === field && c.op === "eq").map((c) => c.value);

/** Ticks (adds an `=`) or unticks (removes it) one value of a facet; an exclusion of it goes. */
export function toggleValue(conds: readonly Cond[], field: FieldKey, value: string, on: boolean): Cond[] {
  const rest = conds.filter((c) => !(c.field === field && (c.op === "eq" || c.op === "neq") && c.value === value));
  if (!on) return rest;
  const c = makeCond(field, "eq", value);
  return c ? dedupe([...rest, c]) : rest;
}

/** "Only": the field's conditions replaced by one `=` of this value. */
export function onlyValue(conds: readonly Cond[], field: FieldKey, value: string): Cond[] {
  const rest = conds.filter((c) => c.field !== field);
  const c = makeCond(field, "eq", value);
  return c ? [...rest, c] : rest;
}

/** A facet's reset: every condition on the field goes. */
export const clearField = (conds: readonly Cond[], field: FieldKey): Cond[] => conds.filter((c) => c.field !== field);

/** The status class of a code or term (`404` → `4xx`, `5xx` → `5xx`, `500-503` → `5xx`). */
export function termClass(term: string): string {
  const m = term.match(/^([1-5])/);
  return m ? `${m[1]}xx` : "";
}

/**
 * The status classes the chart draws: all of them, unless status conditions leave some out. A
 * class stays when an `=` condition overlaps it (or there is none) and no `≠` excludes it whole.
 */
export function shownClasses(conds: readonly Cond[]): Set<"2xx" | "4xx" | "5xx"> {
  const eq = conds.filter((c) => c.field === "status" && c.op === "eq").flatMap((c) => c.value.split(","));
  const neq = conds.filter((c) => c.field === "status" && c.op === "neq").flatMap((c) => c.value.split(","));
  const out = new Set<"2xx" | "4xx" | "5xx">();
  // The chart's grey layer is everything under 400.
  const groups: ["2xx" | "4xx" | "5xx", string[]][] = [
    ["2xx", ["1xx", "2xx", "3xx"]],
    ["4xx", ["4xx"]],
    ["5xx", ["5xx"]],
  ];
  for (const [layer, classes] of groups) {
    const kept = !eq.length || eq.some((t) => classes.includes(termClass(t)) || (t.includes("-") && classes.includes(termClass(t.split("-")[1]))));
    const excluded = classes.every((cls) => neq.includes(cls));
    if (kept && !excluded) out.add(layer);
  }
  return out;
}

/** A count for a facet row: `950`, `1.2k`, `3.4M`. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v < 9.95 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`;
    }
  }
  return String(n);
}

// Typed filters ---------------------------------------------------------------------------------

const TYPED_OPS: [string, Op][] = [
  ["!~", "ncontains"],
  ["!=", "neq"],
  ["≠", "neq"],
  [">=", "gt"],
  ["<=", "lt"],
  [">", "gt"],
  ["<", "lt"],
  ["~", "contains"],
  ["=", "eq"],
  [":", "eq"],
];

const FIELD_ALIASES: Record<string, FieldKey> = { environment: "env", consumer_id: "consumer", group: "consumer_group", trace: "trace_id", ua: "user_agent", size: "response_size" };

/**
 * What the filter bar makes of typed text: `status:500`, `method != GET`, `latency > 500`,
 * `path ~ /orders` for a field, operator and value; `latency 100-500` for a range. Any other
 * text is a path `contains`.
 */
export function typedCond(text: string): Cond | null {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^([a-z_]+)\s*(.*)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const field = isField(name) ? name : FIELD_ALIASES[name];
    if (field) {
      const rest = m[2];
      for (const [sym, op] of TYPED_OPS) {
        if (!rest.startsWith(sym)) continue;
        const value = rest.slice(sym.length).trim();
        const ops = fieldDef(field).ops;
        if (ops.includes(op)) return makeCond(field, op, value);
        // `latency=100-500` and `latency:100-500` read as a range.
        if (op === "eq" && ops.includes("between")) return makeCond(field, "between", value) ?? makeCond(field, "gt", value);
        if (op === "eq" && field === "payload") return makeCond(field, "contains", value);
        return null;
      }
    }
  }
  return makeCond("path", "contains", t);
}

/**
 * Converts the local wall time `local` (`2026-11-05T10:30`, what a datetime-local input holds) in
 * `tz` to an instant, or null when it is not a time.
 */
export function zonedInputToIso(local: string, tz: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  // The zone's offset at that wall time, found by reading the guess back (twice, for DST edges).
  let at = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(at, tz);
    const seen = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
    at += wall - seen;
  }
  return isoSecond(at);
}

/** URLSearchParams as a record, repeated keys (`filter`) as lists. */
export function paramsRecord(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(sp.keys())) {
    const v = sp.getAll(k);
    out[k] = v.length === 1 ? v[0] : v;
  }
  return out;
}

/** The most rows one read of the log answers; the table loads the next page as it nears the end. */
export const PAGE_SIZE = 100;
/** How often Live reads newer rows (Supabase's 10 s). */
export const LIVE_POLL_MS = 10_000;
/** How long the URL waits after the last filter change before it is written. */
export const URL_DEBOUNCE_MS = 250;

/** An instant as a datetime-local input shows it in `tz`: `2026-11-05T10:30`. */
export function isoToZonedInput(iso: string, tz: string): string {
  const p = zonedParts(Date.parse(iso), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
