// Explore filters (#586): every filter `GET /requests` takes, kept in the page URL under the API's
// own parameter names, so a deep link reproduces the filtered view and the Route Handler passes
// them on unchanged. Pure helpers (parse, serialise, chips, the edit form), unit-tested in
// explore-filters.test.ts.
import { formatBytes } from "./explore";

/** The filters of the request log. Text filters are "" when off, ranges null at an open end. */
export interface ExploreFilters {
  env: string;
  method: string;
  status: string;
  path: string;
  url_contains: string;
  payload_contains: string;
  consumer_id: string;
  consumer_group: string;
  ip: string;
  request_size_min: number | null;
  request_size_max: number | null;
  response_size_min: number | null;
  response_size_max: number | null;
  latency_min: number | null;
  latency_max: number | null;
  sampled: "" | "true" | "false";
}

export type FilterKey = keyof ExploreFilters;

/** The URL (and API) order of the filters; a link always lists them in this order. */
export const FILTER_KEYS: readonly FilterKey[] = [
  "env",
  "method",
  "status",
  "path",
  "url_contains",
  "payload_contains",
  "consumer_id",
  "consumer_group",
  "ip",
  "request_size_min",
  "request_size_max",
  "response_size_min",
  "response_size_max",
  "latency_min",
  "latency_max",
  "sampled",
];

export const NO_FILTERS: ExploreFilters = {
  env: "",
  method: "",
  status: "",
  path: "",
  url_contains: "",
  payload_contains: "",
  consumer_id: "",
  consumer_group: "",
  ip: "",
  request_size_min: null,
  request_size_max: null,
  response_size_min: null,
  response_size_max: null,
  latency_min: null,
  latency_max: null,
  sampled: "",
};

type TextKey = "env" | "path" | "url_contains" | "payload_contains" | "consumer_id" | "consumer_group" | "ip";
type NumberKey = "request_size_min" | "request_size_max" | "response_size_min" | "response_size_max" | "latency_min" | "latency_max";

/** The longest value `GET /requests` takes for each text filter. */
export const TEXT_MAX: Record<TextKey, number> = {
  env: 64,
  path: 1024,
  url_contains: 1024,
  payload_contains: 1024,
  consumer_id: 256,
  consumer_group: 256,
  ip: 64,
};

const NUMBER_KEYS: readonly NumberKey[] = ["request_size_min", "request_size_max", "response_size_min", "response_size_max", "latency_min", "latency_max"];
const isNumberKey = (k: FilterKey): k is NumberKey => (NUMBER_KEYS as readonly string[]).includes(k);
/** Sizes are whole bytes; latency may be fractional milliseconds. */
const isWhole = (k: NumberKey) => k !== "latency_min" && k !== "latency_max";

/** The methods offered in the picker; a link may name another, which stays selectable. */
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const METHOD_RE = /^[A-Za-z]{1,16}$/;
/** At most this many terms in a status filter, as the API allows. */
export const MAX_STATUS_TERMS = 20;
const STATUS_MAX = 256;

/**
 * A status filter as the API reads it (codes `404`, classes `4xx`, inclusive ranges `500-503`,
 * comma-separated), normalised: lower case, no spaces, no empty terms. "" for no filter (empty or
 * `all`), null when it is not a valid filter.
 */
export function normalizeStatus(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s === "" || s === "all") return "";
  if (s.length > STATUS_MAX) return null;
  const terms = s
    .split(",")
    .map((t) => t.replace(/\s+/g, ""))
    .filter(Boolean);
  if (terms.length === 0 || terms.length > MAX_STATUS_TERMS) return null;
  const code = (t: string) => (/^\d{3}$/.test(t) && Number(t) >= 100 && Number(t) <= 599 ? Number(t) : null);
  for (const t of terms) {
    if (/^[1-5]xx$/.test(t)) continue;
    const [lo, hi, ...rest] = t.split("-");
    if (rest.length) return null;
    const a = code(lo);
    if (a === null) return null;
    if (hi !== undefined) {
      const b = code(hi);
      if (b === null || b < a) return null;
    }
  }
  return terms.join(",");
}

/** A bound: a finite number at least 0 (whole for sizes), else null. */
function parseBound(input: string, whole: boolean): number | null {
  const s = input.trim();
  if (s === "" || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || (whole && !Number.isSafeInteger(n))) return null;
  return n;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the filters from search params; a value the API would refuse is dropped, not kept. */
export function parseFilters(params: SearchParams): ExploreFilters {
  const f: ExploreFilters = { ...NO_FILTERS };
  for (const k of Object.keys(TEXT_MAX) as TextKey[]) {
    const v = (first(params[k]) ?? "").trim();
    if (v.length <= TEXT_MAX[k]) f[k] = v;
  }
  const method = (first(params.method) ?? "").trim();
  if (METHOD_RE.test(method)) f.method = method.toUpperCase();
  f.status = normalizeStatus(first(params.status) ?? "") ?? "";
  for (const k of NUMBER_KEYS) f[k] = parseBound(first(params[k]) ?? "", isWhole(k));
  const sampled = first(params.sampled);
  if (sampled === "true" || sampled === "false") f.sampled = sampled;
  return f;
}

/** The filters that are on, as `[name, value]` in URL order. */
export function filterEntries(f: ExploreFilters): [FilterKey, string][] {
  const out: [FilterKey, string][] = [];
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v === null || v === "") continue;
    out.push([k, String(v)]);
  }
  return out;
}

/** The filters as `GET /requests` query parameters (only those that are on). */
export const filterQuery = (f: ExploreFilters): Partial<Record<FilterKey, string>> => Object.fromEntries(filterEntries(f));

/** How many filters are on; a min/max pair counts once. */
export function activeCount(f: ExploreFilters): number {
  return filterChips(f).length;
}

/** One removable chip of the filter bar: its words and the filters it clears. */
export interface FilterChip {
  id: string;
  label: string;
  keys: FilterKey[];
}

const ms = (n: number) => `${n} ms`;

function rangeLabel(name: string, lo: number | null, hi: number | null, fmt: (n: number) => string): string | null {
  if (lo !== null && hi !== null) return `${name} ${fmt(lo)} to ${fmt(hi)}`;
  if (lo !== null) return `${name} ≥ ${fmt(lo)}`;
  if (hi !== null) return `${name} ≤ ${fmt(hi)}`;
  return null;
}

/** The chips for the filters that are on, in URL order. */
export function filterChips(f: ExploreFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  const text = (k: FilterKey, label: string) => {
    if (f[k] !== "") chips.push({ id: k, label, keys: [k] });
  };
  text("env", `Environment ${f.env}`);
  text("method", `Method ${f.method}`);
  text("status", `Status ${f.status.split(",").join(", ")}`);
  text("path", `Path ${f.path}`);
  text("url_contains", `URL contains “${f.url_contains}”`);
  text("payload_contains", `Payload contains “${f.payload_contains}”`);
  text("consumer_id", `Consumer ${f.consumer_id}`);
  text("consumer_group", `Group ${f.consumer_group}`);
  text("ip", `IP ${f.ip}`);
  const range = (id: string, name: string, lo: NumberKey, hi: NumberKey, fmt: (n: number) => string) => {
    const label = rangeLabel(name, f[lo], f[hi], fmt);
    if (label) chips.push({ id, label, keys: [lo, hi] });
  };
  range("request_size", "Request size", "request_size_min", "request_size_max", formatBytes);
  range("response_size", "Response size", "response_size_min", "response_size_max", formatBytes);
  range("latency", "Latency", "latency_min", "latency_max", ms);
  if (f.sampled !== "") chips.push({ id: "sampled", label: f.sampled === "true" ? "Kept in full" : "Sampled out", keys: ["sampled"] });
  return chips;
}

/** `f` with the chip's filters off. */
export function withoutChip(f: ExploreFilters, chip: Pick<FilterChip, "keys">): ExploreFilters {
  const out = { ...f };
  for (const k of chip.keys) (out as Record<FilterKey, unknown>)[k] = NO_FILTERS[k];
  return out;
}

/** The edit form: every filter as the text in its field. */
export type FilterDraft = Record<FilterKey, string>;

export function toDraft(f: ExploreFilters): FilterDraft {
  const d = {} as FilterDraft;
  for (const k of FILTER_KEYS) d[k] = f[k] === null ? "" : String(f[k]);
  return d;
}

/** The fields of a draft the API would refuse, with why. */
export type DraftErrors = Partial<Record<FilterKey, string>>;

/**
 * Reads the edit form: the filters it describes, or the fields that are not valid yet (the bar
 * keeps the last valid filters applied until they are).
 */
export function fromDraft(d: FilterDraft): { ok: true; filters: ExploreFilters } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const f: ExploreFilters = { ...NO_FILTERS };
  for (const k of Object.keys(TEXT_MAX) as TextKey[]) {
    const v = d[k].trim();
    if (v.length > TEXT_MAX[k]) errors[k] = `At most ${TEXT_MAX[k]} characters.`;
    else f[k] = v;
  }
  const method = d.method.trim();
  if (method !== "" && !METHOD_RE.test(method)) errors.method = "A method is letters only, like GET.";
  else f.method = method.toUpperCase();
  const status = normalizeStatus(d.status);
  if (status === null) errors.status = `Codes (404), classes (4xx) or ranges (500-503), comma-separated, at most ${MAX_STATUS_TERMS}.`;
  else f.status = status;
  for (const k of NUMBER_KEYS) {
    const v = d[k].trim();
    if (v === "") continue;
    const n = parseBound(v, isWhole(k));
    if (n === null) errors[k] = isWhole(k) ? "A whole number of bytes, 0 or more." : "A number of milliseconds, 0 or more.";
    else f[k] = n;
  }
  for (const [lo, hi] of [
    ["request_size_min", "request_size_max"],
    ["response_size_min", "response_size_max"],
    ["latency_min", "latency_max"],
  ] as const) {
    const a = f[lo];
    const b = f[hi];
    if (a !== null && b !== null && a > b && !errors[lo] && !errors[hi]) errors[hi] = "The maximum is below the minimum.";
  }
  const sampled = d.sampled.trim();
  if (sampled === "true" || sampled === "false") f.sampled = sampled;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, filters: f };
}

/** True when both describe the same filters. */
export const sameFilters = (a: ExploreFilters, b: ExploreFilters) => FILTER_KEYS.every((k) => a[k] === b[k]);

/** How long the bar waits after the last keystroke before it applies typed filters. */
export const FILTER_DEBOUNCE_MS = 400;
