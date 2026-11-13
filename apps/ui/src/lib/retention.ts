// Pure helpers for Project settings › Retention (#805, #753 D10): retention is read-only per
// project and set per install (`retention.<signal>` in the server config, applied by
// `apilens migrate`). The limits below mirror internal/platform/config/retention.go so the page
// can say what an install may set. No React and no server imports.

import type { RetentionSignal, RetentionSignalKey } from "./identity";

/** The signals an install may change, with the default and the allowed range in days. */
export const RETENTION_LIMITS: Partial<Record<RetentionSignalKey, { default: number; min: number; max: number }>> = {
  requests: { default: 90, min: 1, max: 3650 },
  logs: { default: 30, min: 1, max: 3650 },
  spans: { default: 30, min: 1, max: 3650 },
  rollups_1m: { default: 30, min: 1, max: 400 },
  rollups_1h: { default: 400, min: 30, max: 3650 },
};

/** Why `days` is not a valid `retention.<key>`, or null. Deploys are not configurable. */
export function retentionDaysError(key: RetentionSignalKey, days: number): string | null {
  const limit = RETENTION_LIMITS[key];
  if (!limit) return "This signal’s retention can’t be changed.";
  if (!Number.isInteger(days) || days < limit.min || days > limit.max) return `Use ${limit.min} to ${limit.max} days.`;
  return null;
}

/** "1 day", "30 days", "1 year", "10 years": whole years when the period is a multiple of 365. */
export function formatPeriod(days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const years = days / 365;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The allowed range of a configurable signal, in words ("1 to 3650 days"); null otherwise. */
export function rangeLabel(signal: Pick<RetentionSignal, "key" | "configurable">): string | null {
  const limit = RETENTION_LIMITS[signal.key];
  return signal.configurable && limit ? `${limit.min} to ${limit.max} days` : null;
}

/** Whether the install changed the signal from its default. */
export function isCustomized(signal: Pick<RetentionSignal, "key" | "period_days">): boolean {
  const limit = RETENTION_LIMITS[signal.key];
  return limit !== undefined && signal.period_days !== limit.default;
}

/** The longest period over the signals; 0 when there are none. */
export function longestRetention(signals: readonly Pick<RetentionSignal, "period_days">[] | null | undefined): number {
  return (signals ?? []).reduce((m, s) => Math.max(m, s.period_days), 0);
}

/** A sentence for a retention read that failed, by API error code. */
export function retentionError(code: string | undefined): string {
  switch (code) {
    case "not_found":
      return "This project no longer exists, or you no longer have access. Reload the page.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "Couldn’t load retention. Reload the page to try again.";
    default:
      return "Something went wrong loading retention. Reload the page to try again.";
  }
}

/**
 * What happens to a signal's data once its period runs out (Project settings › Retention, #818):
 * ClickHouse deletes it by table TTL. Requests and per-minute metrics say what the hourly metrics
 * still show, when the hourly metrics are kept longer.
 */
export function afterRetention(
  signal: Pick<RetentionSignal, "key" | "period_days">,
  signals: readonly Pick<RetentionSignal, "key" | "period_days">[] | null | undefined,
): string {
  const hourly = (signals ?? []).find((s) => s.key === "rollups_1h");
  const hourlyLonger = hourly !== undefined && hourly.period_days > signal.period_days;
  switch (signal.key) {
    case "requests":
      return hourlyLonger
        ? "Deleted with their headers and bodies. Counts and latencies stay in the hourly metrics."
        : "Deleted with their headers and bodies.";
    case "logs":
      return "Deleted. A request’s trace no longer shows them.";
    case "spans":
      return "Deleted. A request’s trace no longer shows its waterfall.";
    case "rollups_1m":
      return hourlyLonger ? "Deleted. Charts over older ranges use the hourly metrics." : "Deleted.";
    case "rollups_1h":
      return "Deleted. Charts show nothing older.";
    case "deploys":
      return "Deleted. Charts no longer mark them.";
    default:
      return "Deleted.";
  }
}

/** The self-host docs on changing retention (`retention.<signal>`, then `apilens migrate`). */
export function retentionDocsUrl(docs: string): string {
  return `${docs.replace(/\/+$/, "")}/getting-started/data-privacy#changing-retention-self-hosted`;
}
