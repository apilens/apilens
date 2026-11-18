// Explore's request panel and power features (#1053): which section a request opens on (the
// failure first, #988), the error summary, the Timeline rail of spans and logs, row navigation and
// multi-select, the CSV/JSON export of loaded rows, and the time windows the field menus offer.
// Pure helpers, unit-tested in explore-detail.test.ts.
import { isoSecond } from "./explore-timeline";
import { reasonPhrase, statusText } from "./http-status";
import type { RequestDetail, RequestRow, TraceLog, TraceSpan } from "./identity";

/** The Overview section a request opens on: the failure first (#988), else the summary. */
export type LeadSection = "validation" | "exception" | "response" | "summary";

/**
 * Validation when the app reported validation errors, else the Exception when one was captured,
 * else the Response body for a status of 400 or more with a body, else the summary.
 */
export function leadSection(r: Pick<RequestDetail, "status_code" | "validation_errors" | "response_body">, hasException: boolean): LeadSection {
  if ((r.validation_errors ?? []).length) return "validation";
  if (hasException) return "exception";
  if (r.status_code >= 400 && r.response_body.trim()) return "response";
  return "summary";
}

/** The most of a response body the error summary shows before "Show more". */
export const SUMMARY_BODY_CHARS = 300;

/**
 * The Error block on top of Overview for a status of 400 or more: the reason phrase, the first
 * validation message or the exception's type and message, and the start of the response body.
 * Null below 400.
 */
export function errorSummary(
  r: Pick<RequestDetail, "status_code" | "validation_errors" | "response_body">,
  exc: { type?: string; message?: string } | null,
): { title: string; detail: string; body: string; more: boolean } | null {
  if (r.status_code < 400) return null;
  const first = (r.validation_errors ?? [])[0];
  const detail = first ? `${first.loc}: ${first.msg}` : exc ? [exc.type, exc.message].filter(Boolean).join(": ") : "";
  const body = r.response_body.trim();
  return { title: statusText(r.status_code), detail, body: body.slice(0, SUMMARY_BODY_CHARS), more: body.length > SUMMARY_BODY_CHARS };
}

/** The query string of a raw URL as name/value pairs, decoded. */
export function queryPairs(rawPath: string): [string, string][] {
  const i = rawPath.indexOf("?");
  if (i < 0) return [];
  return [...new URLSearchParams(rawPath.slice(i + 1)).entries()];
}

/** One step of the Timeline rail: a span or a log of the request's trace. */
export type Step =
  | { kind: "span"; at: string; offset: number; span: TraceSpan; failed: boolean }
  | { kind: "log"; at: string; offset: number; log: TraceLog; level: "error" | "warn" | "plain" };

/** The spans and logs of a request on one rail, by time, each with its offset (ms) from the request. */
export function timelineSteps(spans: readonly TraceSpan[], logs: readonly TraceLog[], requestAt: string): Step[] {
  const t0 = Date.parse(requestAt);
  const off = (at: string) => (Number.isNaN(t0) ? 0 : Date.parse(at) - t0);
  const level = (l: string): "error" | "warn" | "plain" => {
    const v = l.toLowerCase();
    if (v === "error" || v === "fatal" || v === "critical") return "error";
    if (v === "warn" || v === "warning") return "warn";
    return "plain";
  };
  const steps: Step[] = [
    ...spans.map((s) => ({ kind: "span" as const, at: s.start, offset: off(s.start), span: s, failed: s.status.toLowerCase() === "error" || s.status_code >= 500 })),
    ...logs.map((l) => ({ kind: "log" as const, at: l.timestamp, offset: off(l.timestamp), log: l, level: level(l.level) })),
  ];
  return steps.sort((a, b) => a.offset - b.offset || (a.kind === b.kind ? 0 : a.kind === "span" ? -1 : 1));
}

/** How many Timeline steps show before "+N more". */
export const TIMELINE_FIRST = 3;

/** An offset in words: `+12.4 ms`, `+1,204 ms`, `−0.8 ms`. */
export function offsetText(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const a = Math.abs(ms);
  return `${ms < 0 ? "−" : "+"}${a < 10_000 ? a.toFixed(1) : Math.round(a).toLocaleString("en-US")} ms`;
}

/** The id `delta` rows from `id` in the loaded rows (clamped), or null when `id` is not among them. */
export function neighborId(rows: readonly Pick<RequestRow, "id">[], id: string, delta: number): string | null {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const j = Math.max(0, Math.min(rows.length - 1, i + delta));
  return rows[j].id ?? null;
}

/** The keys from `a` to `b` (either order) in `keys`: a Shift-click or Shift+arrow selection. */
export function rangeKeys(keys: readonly string[], a: string, b: string): string[] {
  const i = keys.indexOf(a);
  const j = keys.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : [];
  return keys.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** A window of `minutes` either side of an instant: "Show it in the list" opens around the request. */
export function windowAround(at: string, minutes: number): { from: string; to: string } | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return { from: isoSecond(t - minutes * 60_000), to: isoSecond(t + minutes * 60_000) };
}

/** The minute or hour holding an instant (Same minute / Same hour in a time's menu), UTC-aligned. */
export function sameWindow(at: string, unit: "minute" | "hour"): { from: string; to: string } | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  const size = unit === "minute" ? 60_000 : 3_600_000;
  const start = Math.floor(t / size) * size;
  return { from: isoSecond(start), to: isoSecond(start + size) };
}

/** The columns of an export, in order. */
export const EXPORT_COLUMNS = [
  "timestamp",
  "method",
  "path",
  "raw_path",
  "status_code",
  "response_time_ms",
  "request_size",
  "response_size",
  "environment",
  "app_id",
  "consumer_id",
  "consumer_name",
  "consumer_group",
  "ip_address",
  "trace_id",
  "id",
] as const satisfies readonly (keyof RequestRow)[];

/** A CSV field, quoted when it holds a comma, quote or line break, and guarded against spreadsheet formulas. */
function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Rows as CSV (RFC 4180, CRLF), a header line first. */
export function toCsv(rows: readonly RequestRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvField(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Rows as pretty JSON, only the exported columns. */
export function toJson(rows: readonly RequestRow[]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, r[c] ?? null]))),
    null,
    2,
  );
}

/** An export's file name: `apilens-shop-requests-1h-20261105T101500Z.csv`. */
export function exportFileName(project: string, range: string, now: number, ext: "csv" | "json"): string {
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(/[-:]/g, "");
  const safe = (s: string) => s.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return `apilens-${safe(project)}-requests-${safe(range)}-${stamp}.${ext}`;
}

/** The row limits the export dialog offers. */
export const EXPORT_LIMITS = [100, 500, 1000, 10_000] as const;

/** A status code with its reason, for the panel's badge. */
export const badgeText = (code: number) => (reasonPhrase(code) ? statusText(code) : String(code));
