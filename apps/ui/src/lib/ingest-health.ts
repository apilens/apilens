// Project settings → Ingest health (#602): per app, what the ingest edge did with its records
// (`GET /apps/{id}/ingest-stats`: accepted, rejected, truncated, masked per UTC day) and what its
// SDKs dropped before sending (`sdk_stats` of `GET /apps/{id}/status`). The labels, sentences and
// shares the panel shows. Pure; safe in Client and Server Components alike.
import type { AppSdkStats, IngestCounts } from "./identity";
import { LINKS } from "./links";

/** The section of project settings that shows an app's ingest health. */
export const INGEST_SECTION = "ingest";

/** UTC days the panel covers, today included (`days` of `GET /apps/{id}/ingest-stats`). */
export const INGEST_DAYS = 7;

/** `/<project>/settings/ingest`, on `app` when given. */
export function ingestPath(project: string, app?: string): string {
  const base = `/${project}/settings/${INGEST_SECTION}`;
  return app ? `${base}?app=${encodeURIComponent(app)}` : base;
}

/** The docs page that says what each counter means and what to do when it moves. */
export const INGEST_RUNBOOK = `${LINKS.docs.replace(/\/+$/, "")}/ingest/ingest-health`;

/** The edge counters in the order the panel shows them, with what each one counts. */
export const EDGE_COUNTERS: { key: keyof IngestCounts; label: string; help: string }[] = [
  { key: "accepted", label: "Accepted", help: "Records stored" },
  { key: "rejected", label: "Rejected", help: "Over the ingest quota, or invalid" },
  { key: "truncated", label: "Truncated", help: "Payload or header fields cut to the server cap" },
  { key: "masked", label: "Masked", help: "Records with a value masked by the privacy policy" },
];

/** `1,234`. */
export function formatCount(n: number): string {
  return Math.max(0, Math.trunc(n)).toLocaleString("en-US");
}

/** `1 batch`, `3 batches`. */
export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** `n` as a share of `of`: `0.4%`, `<0.1%` for a tiny non-zero share, null when `of` is 0. */
export function share(n: number, of: number): string | null {
  if (of <= 0) return null;
  const pct = (n / of) * 100;
  if (n > 0 && pct < 0.1) return "<0.1%";
  return `${Math.round(pct * 10) / 10}%`;
}

/** The sub-line of an edge counter: rejected as a share of what arrived, the others of what was stored. */
export function counterShare(key: keyof IngestCounts, c: IngestCounts): string | null {
  if (key === "accepted") return null;
  const of = key === "rejected" ? c.accepted + c.rejected : c.accepted;
  const s = share(c[key], of);
  if (s === null) return null;
  return key === "rejected" ? `${s} of received` : `${s} of accepted`;
}

/** The SDK drop reasons, as the Python, TypeScript and Java SDKs name them. */
const DROP_REASONS: Record<string, string> = {
  queue_full: "Queue full (record limit)",
  queue_bytes: "Queue full (memory limit)",
  non_retryable: "Refused by ingest (4xx)",
  retries_exhausted: "Still failing after retries",
};

/** Not a drop: a record the SDK shortened to fit a batch and still sent. */
const SHORTENED = "truncated";

export interface DropReason {
  reason: string;
  label: string;
  count: number;
}

/** Records dropped per reason, most first; reasons without drops and shortened records are left out. */
export function dropReasons(stats: AppSdkStats): DropReason[] {
  return Object.entries(stats.drop_counts ?? {})
    .filter(([reason, n]) => reason !== SHORTENED && n > 0)
    .map(([reason, count]) => ({ reason, label: DROP_REASONS[reason] ?? reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Records the SDKs shortened to fit a batch and still sent. */
export function shortenedRecords(stats: AppSdkStats): number {
  return Math.max(0, stats.drop_counts?.[SHORTENED] ?? 0);
}

/**
 * One line on what the app's SDKs lost, for the panel and the app card: `3 batches failed ·
 * 12 records dropped`, or null when nothing was lost or no instance reported in the last hour.
 */
export function dropSummary(stats: AppSdkStats): string | null {
  if (stats.instances <= 0) return null;
  const parts: string[] = [];
  if (stats.failed_batches > 0) parts.push(`${plural(stats.failed_batches, "batch", "batches")} failed`);
  if (stats.dropped_records > 0) parts.push(`${plural(stats.dropped_records, "record", "records")} dropped`);
  return parts.length ? parts.join(" · ") : null;
}

/** What the SDK card says under its heading. */
export function sdkLine(stats: AppSdkStats): string {
  if (stats.instances <= 0) return "No SDK instance sent a heartbeat in the last hour, so there are no SDK counters to show.";
  const who = `${plural(stats.instances, "instance", "instances")} seen in the last hour`;
  return dropSummary(stats) === null ? `Nothing dropped by the ${who}.` : `Summed over the ${who}, since each process started.`;
}
