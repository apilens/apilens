// The Errors page (#594): the project's error responses by status code (4xx and 5xx over time and
// a status table), one status code's detail in a modal (summary and frequency, consumers, and the
// per-endpoint details pointing at validation errors and exceptions), "mark as expected", and the
// endpoint × status list as the Issues tab. Pure helpers (URL state, copy, settings merge),
// unit-tested in errors.test.ts.
import { RANGE_LABEL } from "./consumers";
import type { EndpointSettings, PutEndpointSettingsRequest, QueryRange } from "./identity";
import { DEFAULT_RANGE, TRAFFIC_RANGES } from "./traffic";

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

/** The longest environment name the API takes. */
const MAX_ENV = 64;

/**
 * The page's state, all of it in the URL: `?tab=&range=&env=&code=&view=`. An empty env means all
 * environments; `code` is the error status code whose modal is open (null when none), `view` the
 * modal's open view.
 */
export interface ErrorsState {
  tab: ErrorsTab;
  range: QueryRange;
  env: string;
  code: number | null;
  view: DetailTab;
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
  return {
    tab: ERRORS_TABS.some((t) => t.slug === tab) ? (tab as ErrorsTab) : DEFAULT_TAB,
    range: TRAFFIC_RANGES.includes(range as QueryRange) ? (range as QueryRange) : DEFAULT_RANGE,
    env: env.length <= MAX_ENV ? env : "",
    code: isErrorCode(code) ? code : null,
    view: DETAIL_TABS.some((t) => t.slug === view) ? (view as DetailTab) : DEFAULT_DETAIL,
  };
}

/** The page URL for `q`, leaving defaults out. The modal (code, view) belongs to the status tab. */
export function errorsHref(project: string, q: Partial<ErrorsState>): string {
  const p = new URLSearchParams();
  const tab = q.tab ?? DEFAULT_TAB;
  if (tab !== DEFAULT_TAB) p.set("tab", tab);
  if (q.range && q.range !== DEFAULT_RANGE) p.set("range", q.range);
  if (q.env) p.set("env", q.env);
  if (tab === "status" && q.code && isErrorCode(q.code)) {
    p.set("code", String(q.code));
    if (q.view && q.view !== DEFAULT_DETAIL) p.set("view", q.view);
  }
  const s = p.toString();
  return `/${encodeURIComponent(project)}/errors${s ? `?${s}` : ""}`;
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

export const STATUSES_LOAD_FAILED = "We couldn’t load errors just now.";
export const DETAIL_LOAD_FAILED = "We couldn’t load this status code just now.";
export const ISSUES_LOAD_FAILED = "We couldn’t load issues just now.";
