// The Errors page (#594): the project's error responses by status code (4xx and 5xx over time and
// a status table), one status code's detail in a modal (summary and frequency, consumers, and the
// per-endpoint details pointing at validation errors and exceptions), "mark as expected", and the
// endpoint × status list as the Issues tab. Pure helpers (URL state, copy, settings merge),
// unit-tested in errors.test.ts.
import { RANGE_LABEL } from "./consumers";
import type { EndpointSettings, PutEndpointSettingsRequest, QueryRange } from "./identity";
import { DEFAULT_PER, type PageOptions, parsePage } from "./pagination";
import { envParam } from "./scope-defaults";
import { DEFAULT_RANGE, TRAFFIC_RANGES } from "./traffic";
import { projectHref } from "./routes";
import { zoned } from "./time-zone";

export const ERRORS_TABS = [
  { slug: "status", label: "Status codes" },
  { slug: "issues", label: "Issues" },
] as const;
export type ErrorsTab = (typeof ERRORS_TABS)[number]["slug"];
const DEFAULT_TAB: ErrorsTab = "status";

/** The views of one status code's modal. */
export const DETAIL_TABS = [
  { slug: "summary", label: "Summary" },
  { slug: "consumers", label: "Consumers" },
  { slug: "details", label: "Details" },
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number]["slug"];
const DEFAULT_DETAIL: DetailTab = "summary";

/** The paging of the open tab's table (`?page=&per=`) and of the modal's list (`?dpage=&dper=`). */
export const TABLE_PAGING: PageOptions = {};
export const DETAIL_PAGING: PageOptions = { sizes: [10, 25, 50], defaultPer: 10, keys: { page: "dpage", per: "dper" } };
const DETAIL_PER = 10;

/** The longest environment name the API takes. */
const MAX_ENV = 64;

/**
 * The page's state, all of it in the URL: `?tab=&range=&env=&code=&view=&page=&per=&dpage=&dper=`.
 * An empty env means all environments; `code` is the error status code whose modal is open (null
 * when none), `view` the modal's open view. `page`/`per` page the open tab's table, `dpage`/`dper`
 * the modal's list (consumers or endpoints).
 */
export interface ErrorsState {
  tab: ErrorsTab;
  range: QueryRange;
  env: string;
  code: number | null;
  view: DetailTab;
  page: number;
  per: number;
  dpage: number;
  dper: number;
}

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Whether `v` is an error status code the API takes (400 to 599). */
export function isErrorCode(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 400 && v <= 599;
}

/** Reads the page state from search params; anything unknown falls back to the default. */
export function parseErrorsQuery(params: SearchParams): ErrorsState {
  const tab = first(params.tab);
  const range = first(params.range);
  const env = (first(params.env) ?? "").trim();
  const rawCode = first(params.code) ?? "";
  const code = /^\d{3}$/.test(rawCode) ? Number(rawCode) : Number.NaN;
  const view = first(params.view);
  const table = parsePage(params, TABLE_PAGING);
  const detail = parsePage(params, DETAIL_PAGING);
  return {
    tab: ERRORS_TABS.some((t) => t.slug === tab) ? (tab as ErrorsTab) : DEFAULT_TAB,
    range: TRAFFIC_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: env.length <= MAX_ENV ? env : "",
    code: isErrorCode(code) ? code : null,
    view: DETAIL_TABS.some((t) => t.slug === view) ? (view as DetailTab) : DEFAULT_DETAIL,
    page: table.page,
    per: table.per,
    dpage: detail.page,
    dper: detail.per,
  };
}

/**
 * The page URL for `q`, leaving defaults out (a range and env always go in, #993). The modal (code, view and its list's page) belongs to
 * the status tab. Links that change the tab, range or environment pass `page: 1` (the reader starts
 * again at the top); `per` is a preference and stays.
 */
export function errorsHref(project: string, q: Partial<ErrorsState>): string {
  const p = new URLSearchParams();
  const tab = q.tab ?? DEFAULT_TAB;
  if (tab !== DEFAULT_TAB) p.set("tab", tab);
  if (q.range) p.set("range", q.range);
  if (q.env !== undefined) p.set("env", envParam(q.env));
  if (q.page && q.page > 1) p.set("page", String(q.page));
  if (q.per && q.per !== DEFAULT_PER) p.set("per", String(q.per));
  if (tab === "status" && q.code && isErrorCode(q.code)) {
    p.set("code", String(q.code));
    if (q.view && q.view !== DEFAULT_DETAIL) p.set("view", q.view);
    if (q.dpage && q.dpage > 1) p.set("dpage", String(q.dpage));
    if (q.dper && q.dper !== DETAIL_PER) p.set("dper", String(q.dper));
  }
  const s = p.toString();
  return `${projectHref(project, "errors")}${s ? `?${s}` : ""}`;
}

/** The scope in words: `the last 24 hours in production`. */
export function errorsScopeText(q: Pick<ErrorsState, "range" | "env">): string {
  return `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}`;
}

/** `4xx` or `5xx`, for the status badge. */
export const statusClass = (code: number) => (code >= 500 ? "5xx" : "4xx");

/** The usual reason phrase of an error status code, or "" for codes without a common one. */
export function reasonPhrase(code: number): string {
  return REASONS[code] ?? "";
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  507: "Insufficient Storage",
  508: "Loop Detected",
  511: "Network Authentication Required",
};

/** A frequency in occurrences per hour: `0`, `<0.1`, `2.4`, `310`. */
export function formatPerHour(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 0.1) return "<0.1";
  if (n < 100) return n.toFixed(1).replace(/\.0$/, "");
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

// Since when and for whom (#1002) ----------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SEEN_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/**
 * When an error was seen, relative to `now`: `just now`, `5 min ago`, `3 h ago`, `2 days ago`,
 * then, from 30 days back, the day in `tz` (`Oct 2, 2026`). The exact time goes in its title
 * ({@link formatExact}). Empty for an unreadable time.
 */
export function seenAgo(iso: string, tz: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ago = Math.max(0, now - t);
  if (ago < MINUTE_MS) return "just now";
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} min ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} h ago`;
  const d = Math.floor(ago / DAY_MS);
  if (d < 30) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return zoned("en-US", SEEN_DAY, tz).format(t);
}

/**
 * The error rate of each bucket: its 4xx and 5xx responses over its requests, 0 for a bucket
 * without requests. Drawn as a line over the error counts.
 */
export function errorRates(points: readonly { requests: number; client_errors: number; server_errors: number }[]): number[] {
  return points.map((p) => (p.requests > 0 ? (p.client_errors + p.server_errors) / p.requests : 0));
}

const RATE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1];

/** A round top for the error-rate line's own scale: the smallest step at or above the highest rate (1% at least, 100% at most). */
export function rateTop(rates: readonly number[]): number {
  const max = Math.max(0, ...rates.filter(Number.isFinite));
  return RATE_STEPS.find((s) => s >= max) ?? 1;
}

/** `5%`, `0.5%`: a round scale top, without the trailing `.0` formatPercent keeps. */
export function formatRateTop(top: number): string {
  return `${Number((top * 100).toFixed(1))}%`;
}

/** The docs page on telling APILens who calls (the SDK's `set_consumer`), under the docs root `docs`. */
export function consumerIdentificationUrl(docs: string): string {
  return `${docs.replace(/\/+$/, "")}/sdk-reference/consumers`;
}

// Mark as expected -------------------------------------------------------------------------

/**
 * The settings to save so `code` is expected for an endpoint, keeping everything else as saved;
 * null when it already is (nothing to save). The API takes at most 32 expected codes.
 */
export function withExpectedCode(saved: Pick<EndpointSettings, "expected_status_codes" | "latency_threshold_ms" | "excluded">, code: number): PutEndpointSettingsRequest | null {
  const codes = saved.expected_status_codes ?? [];
  if (codes.includes(code)) return null;
  return {
    expected_status_codes: [...codes, code].sort((a, b) => a - b),
    latency_threshold_ms: saved.latency_threshold_ms,
    excluded: saved.excluded,
  };
}

/** A sentence for an API error code when marking a status code as expected. */
export function markExpectedError(code: string): string {
  switch (code) {
    case "forbidden":
      return "Only project admins can mark status codes as expected.";
    case "not_found":
      return "This project or its apps no longer exist, or you’re no longer a member.";
    case "no_apps":
      return "This project has no apps yet, so there are no endpoint settings to change.";
    case "too_many":
      return "This endpoint already has 32 expected status codes, the most it can have. Remove one in the endpoint’s settings first.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "That status code or endpoint wasn’t accepted. Reload the page and try again.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/** The plain search params of `href` (a page URL), for <Pagination params>. */
export function hrefParams(href: string): Record<string, string> {
  const i = href.indexOf("?");
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(href.slice(i + 1)));
}

export const STATUSES_LOAD_FAILED = "We couldn’t load errors just now.";
export const DETAIL_LOAD_FAILED = "We couldn’t load this status code just now.";
export const ISSUES_LOAD_FAILED = "We couldn’t load issues just now.";
