// Project settings → Usage (#819): how many records the project sent over the last 30 UTC days
// (`GET /projects/{slug}/usage`, #790), split by app and environment, what the edge rejected and
// why, and how close today is to the bytes quota. The same counters as Ingest health, summed over
// the project's apps. Pure; safe in Client and Server Components alike.
import { formatBytes } from "./explore";
import type { QuotaUsage, RejectedRecords, UsageDay } from "./identity";
import { formatCount, plural } from "./ingest-health";

/** UTC days the section covers, today included (`days` of `GET /projects/{slug}/usage`, at most 30). */
export const USAGE_DAYS = 30;

/** Why the edge refused records, as the API names the reasons. Unknown codes show as they are. */
const REJECT_REASONS: Record<string, string> = {
  records_per_minute: "Over the records-per-minute quota",
  bytes_per_day: "Over the bytes-per-day quota",
  invalid: "Invalid record",
  app_create_forbidden: "Unknown app, the key may not create apps",
  app_not_allowed: "App not allowed for the key",
  app_deleted: "App deleted",
  app_limit: "Apps-per-project limit reached",
  app_rate_limit: "Too many new apps this hour",
  unspecified: "Reason not recorded",
};

export interface RejectReason {
  reason: string;
  label: string;
  records: number;
}

/** Rejections by reason with a readable label, most first; reasons without records are left out. */
export function rejectReasons(rows: readonly RejectedRecords[] | null | undefined): RejectReason[] {
  return (rows ?? [])
    .filter((r) => r.records > 0)
    .map((r) => ({ reason: r.reason, label: REJECT_REASONS[r.reason] ?? r.reason, records: r.records }))
    .sort((a, b) => b.records - a.records || a.reason.localeCompare(b.reason));
}

/** One day's bar of accepted records. */
export interface UsageBar {
  date: string;
  x: number;
  w: number;
  y: number;
  h: number;
}

/**
 * The accepted-records-per-day chart: one bar per day in `days` order (oldest first), `width` ×
 * `height` in viewBox units, a 25% gap between bars. The top is the busiest day, at least 1 so an
 * empty month draws flat.
 */
export function usageBars(days: readonly UsageDay[], width: number, height: number): { top: number; bars: UsageBar[] } {
  const top = Math.max(1, ...days.map((d) => Math.max(0, d.accepted)));
  const slot = days.length ? width / days.length : width;
  const w = slot * 0.75;
  const bars = days.map((d, i) => {
    const h = (Math.max(0, d.accepted) / top) * height;
    return { date: d.date, x: i * slot + (slot - w) / 2, w, y: height - h, h };
  });
  return { top, bars };
}

/** The chart's text alternative: the total, the daily average and the busiest day. */
export function usageSummary(days: readonly UsageDay[], dayLabel: (date: string) => string): string {
  if (days.length === 0) return "No days to show.";
  const total = days.reduce((n, d) => n + Math.max(0, d.accepted), 0);
  if (total === 0) return `No records accepted in the ${days.length} days.`;
  const busiest = days.reduce((a, b) => (b.accepted > a.accepted ? b : a));
  const avg = Math.round(total / days.length);
  return `${plural(total, "record", "records")} accepted in the ${days.length} days, ${formatCount(avg)} a day on average. Busiest day ${dayLabel(busiest.date)}: ${formatCount(busiest.accepted)}.`;
}

/** The bytes quota meter: today's share clamped to 0–100, its label and a tone; null when bytes are unlimited. */
export function quotaMeter(q: QuotaUsage): { percent: number; label: string; tone: "ok" | "warn" | "over" } | null {
  if (q.bytes_per_day <= 0 || q.bytes_today_ratio === null) return null;
  const ratio = Math.max(0, q.bytes_today_ratio);
  const percent = Math.min(100, Math.round(ratio * 1000) / 10);
  const label = `${formatBytes(q.bytes_today)} of ${formatBytes(q.bytes_per_day)} today (${percent}%)`;
  return { percent, label, tone: ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok" };
}

/** One line on the records-per-minute limit. */
export function recordsLimitLine(q: QuotaUsage): string {
  return q.records_per_minute > 0 ? `${plural(q.records_per_minute, "record", "records")} a minute` : "Unlimited";
}
