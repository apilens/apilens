// Explore CSV export (#590): the filtered request log as a gzip-compressed CSV, written by a
// background job of the API (#579). Export starts one with the page's range and filters, a toast
// follows its progress, and Exports lists the user's recent ones in this browser. Pure helpers
// (the request body, what a job's state reads as, the poll answer, the browser's history list),
// unit-tested in explore-export.test.ts.
import { RANGE_LABEL } from "./consumers";
import { formatBytes } from "./explore";
import { type ExploreFilters, FILTER_KEYS, activeCount } from "./explore-filters";
import type { ExportFilterBody, ExportStatus, QueryRange, RequestExport } from "./identity";

/** The most rows one export writes, newest first, as the API caps it. */
export const MAX_EXPORT_ROWS = 1_000_000;
/** How often the toast reads a running export again. */
export const EXPORT_POLL_MS = 1_000;
/** How many exports the history list keeps per project. */
export const HISTORY_MAX = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Whether `id` can be an export's id (a UUID). */
export const isExportId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/** The body of an export: the page's range and the filters that are on, as the API types them. */
export function exportBody(range: QueryRange, f: ExploreFilters): ExportFilterBody {
  const body: Record<string, string | number> = { range };
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v === null || v === "") continue;
    body[k] = v;
  }
  return body as ExportFilterBody;
}

/** What an export covers, in words: `the last 1 hour, 2 filters on`. */
export function exportScope(range: QueryRange, f: ExploreFilters): string {
  const n = activeCount(f);
  return `the last ${RANGE_LABEL[range]}${n === 0 ? ", no filters" : n === 1 ? ", 1 filter on" : `, ${n} filters on`}`;
}

/** The status an export is in now: a completed one whose expiry passed reads as expired. */
export function exportStatus(x: Pick<RequestExport, "status" | "expires_at">, now: number): ExportStatus {
  if (x.status === "completed" && x.expires_at && Date.parse(x.expires_at) <= now) return "expired";
  return x.status;
}

/** Whether an export is still on its way (the toast keeps reading it). */
export const isActive = (s: ExportStatus) => s === "queued" || s === "running";

/** Whether an export can be downloaded now. */
export const canDownload = (x: Pick<RequestExport, "status" | "expires_at" | "download_url">, now: number) => exportStatus(x, now) === "completed" && !!x.download_url;

const COUNT = new Intl.NumberFormat("en-US");
const rows = (n: number) => `${COUNT.format(n)} ${n === 1 ? "row" : "rows"}`;

/** The progress of an export as a whole percent, 0 to 100. */
export const percent = (x: Pick<RequestExport, "progress">) => Math.max(0, Math.min(100, Math.floor((Number.isFinite(x.progress) ? x.progress : 0) * 100)));

/** The title of an export's toast or history row, by status. */
export function exportTitle(s: ExportStatus): string {
  switch (s) {
    case "queued":
      return "Export waiting to start";
    case "running":
      return "Exporting requests";
    case "completed":
      return "Export ready";
    case "failed":
      return "Export failed";
    case "cancelled":
      return "Export cancelled";
    case "expired":
      return "Export expired";
  }
}

/** The line under the title: progress, the file, or what went wrong and what to do. */
export function exportDetail(x: Pick<RequestExport, "status" | "expires_at" | "total_rows" | "rows_written" | "size_bytes" | "error">, now: number): string {
  const s = exportStatus(x, now);
  switch (s) {
    case "queued":
      return "It starts as soon as a worker is free.";
    case "running":
      return x.total_rows === null ? `${rows(x.rows_written)} written so far.` : `${COUNT.format(x.rows_written)} of ${rows(x.total_rows)} written.`;
    case "completed":
      return `${rows(x.rows_written)}, ${formatBytes(x.size_bytes)} gzip CSV.${x.expires_at ? ` Downloadable until ${expiryText(x.expires_at, now)}.` : ""}`;
    case "failed":
      return `${x.error?.trim() ? `${x.error.trim().replace(/\.$/, "")}. ` : ""}Start a new export to try again.`;
    case "cancelled":
      return "No file was kept.";
    case "expired":
      return "Exports can be downloaded for 24 hours. Start a new export for these requests.";
  }
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** An expiry: `18:40 UTC` today, `Nov 6, 18:40 UTC` on another day. */
export function expiryText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return `${DAY.format(t) === DAY.format(now) ? TIME.format(t) : DAY_TIME.format(t)} UTC`;
}

/** When an export was asked for, for the history list: `Nov 5, 10:02 UTC`. */
export function createdText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : `${DAY_TIME.format(t)} UTC`;
}

/** What the export of a history row covered: `Last 1 hour, 2 filters`. */
export function filterText(f: ExportFilterBody | null | undefined): string {
  const b = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
  const range = typeof b.range === "string" && b.range in RANGE_LABEL ? (b.range as QueryRange) : "24h";
  // A min/max pair is one filter, as the filter bar counts it.
  const keys = new Set(
    Object.keys(b)
      .filter((k) => k !== "range" && b[k] !== undefined && b[k] !== null && b[k] !== "")
      .map((k) => k.replace(/_(min|max)$/, "")),
  );
  return `Last ${RANGE_LABEL[range]}${keys.size === 0 ? "" : keys.size === 1 ? ", 1 filter" : `, ${keys.size} filters`}`;
}

/** The export with its download link made absolute against the browser-facing API origin. */
export function withPublicLink(x: RequestExport, publicApiUrl: string): RequestExport {
  if (!x.download_url) return x;
  try {
    return { ...x, download_url: new URL(x.download_url, `${publicApiUrl.replace(/\/+$/, "")}/`).href };
  } catch {
    return { ...x, download_url: null };
  }
}

/** One read of an export through the Route Handler, as the toast and history care. */
export type ExportPoll = { kind: "export"; export: RequestExport } | { kind: "gone" } | { kind: "expired"; next: string } | { kind: "error"; code: string };

/** Reads the Route Handler's answer (`{ok: true, export}` or `{ok: false, code, next?}`). */
export function exportPoll(status: number, body: unknown): ExportPoll {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.ok === true && typeof b.export === "object" && b.export !== null) return { kind: "export", export: b.export as RequestExport };
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  if (code === "not_found") return { kind: "gone" };
  return { kind: "error", code };
}

/** The Route Handler that reads one export: `GET /api/exports/{id}`. */
export const exportPath = (id: string) => `/api/exports/${encodeURIComponent(id)}`;

/** A sentence for a failed start or cancel, by API error code. */
export function exportError(code: string): string {
  switch (code) {
    case "validation_failed":
    case "bad_request":
    case "invalid_request":
      return "The API refused these filters. Change them and try again.";
    case "forbidden":
      return "You can’t export this project’s requests.";
    case "not_found":
      return "That export no longer exists.";
    case "conflict":
      return "The export already finished, so there is nothing to cancel.";
    case "rate_limited":
      return "Too many exports at once. Wait a moment and try again.";
    case "unavailable":
    case "server_error":
      return "Exports aren’t available right now. Try again in a moment.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

// History: the ids of the user's recent exports of a project, newest first, kept in this browser
// only (the API lists no exports). Every read and write tolerates storage that is missing,
// blocked or full.

type Store = Pick<Storage, "getItem" | "setItem">;

export const historyKey = (project: string) => `apilens:explore-exports:${project}`;

/** The export ids remembered for `project`, newest first; [] when there are none or storage fails. */
export function readHistory(store: Store | null, project: string): string[] {
  try {
    const raw = store?.getItem(historyKey(project));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? [...new Set(list.filter(isExportId))].slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function writeHistory(store: Store | null, project: string, ids: string[]): string[] {
  try {
    store?.setItem(historyKey(project), JSON.stringify(ids));
  } catch {
    // A blocked or full storage only loses the list.
  }
  return ids;
}

/** Puts `id` first in the history of `project`, keeping at most HISTORY_MAX. */
export const rememberExport = (store: Store | null, project: string, id: string): string[] =>
  writeHistory(store, project, [id, ...readHistory(store, project).filter((x) => x !== id)].slice(0, HISTORY_MAX));

/** Drops `id` (an export the API no longer has) from the history of `project`. */
export const forgetExport = (store: Store | null, project: string, id: string): string[] =>
  writeHistory(
    store,
    project,
    readHistory(store, project).filter((x) => x !== id),
  );
