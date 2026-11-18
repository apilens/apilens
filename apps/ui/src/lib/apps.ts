// The Apps overview (#591): one card per app of a project with its traffic over the last 24 hours
// (requests per minute, error rate, p95 and a requests sparkline), its health, whether its SDKs
// are reporting and the SDK version against the latest release. Pure helpers, unit-tested in
// apps.test.ts.
import type { AppInstance, AppReporting, AppSdk, AppStatus, QueryRange, TrafficSummary } from "./identity";

/** The range every card covers. */
export const APPS_RANGE: QueryRange = "24h";

/** An app's page (`/<project>/apps/<app>`). */
export function appHref(project: string, app: string): string {
  return `/${encodeURIComponent(project)}/apps/${encodeURIComponent(app)}`;
}

/** The overview's own URL. */
export function appsHref(project: string): string {
  return `/${encodeURIComponent(project)}/apps`;
}

export const REPORTING_LABEL: Record<AppReporting, string> = {
  reporting: "Reporting",
  stale: "Stale",
  silent: "Silent",
  never: "Never reported",
};

/** Why each state is shown, for the pill's title. */
export const REPORTING_HINT: Record<AppReporting, string> = {
  reporting: "A heartbeat arrived in the last 2 minutes.",
  stale: "No heartbeat in the last 2 minutes.",
  silent: "No heartbeat in the last hour.",
  never: "The SDK has not sent a heartbeat yet.",
};

/** The pill tone of a state: reporting is fine, stale a warning, silent an error, never neutral. */
export function reportingTone(status: AppReporting): "ok" | "warn" | "error" | "none" {
  if (status === "reporting") return "ok";
  if (status === "stale") return "warn";
  if (status === "silent") return "error";
  return "none";
}

/** When a heartbeat last arrived, relative to `now`: `just now`, `4 min ago`, `3 h ago`, `2 days ago`. */
export function formatLastSeen(at: string | null, now: number): string {
  if (!at) return "No heartbeat yet";
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "No heartbeat yet";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Last seen just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `Last seen ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Last seen ${h} h ago`;
  const d = Math.floor(h / 24);
  return `Last seen ${d} ${d === 1 ? "day" : "days"} ago`;
}

/** Health from the share of 5xx responses: failing at 5% or more, degraded at 1% or more. */
export const FAILING_5XX = 0.05;
export const DEGRADED_5XX = 0.01;

export type AppHealth = "healthy" | "degraded" | "failing" | "idle";

export const HEALTH_LABEL: Record<AppHealth, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  idle: "No traffic",
};

export function appHealth(s: Pick<TrafficSummary, "requests" | "server_errors">): AppHealth {
  if (s.requests <= 0) return "idle";
  const rate = s.server_errors / s.requests;
  if (rate >= FAILING_5XX) return "failing";
  if (rate >= DEGRADED_5XX) return "degraded";
  return "healthy";
}

/** An SDK's versions in use: `apilens-python 0.3.2`, or `0.3.2 to 0.4.0` when several run. */
export function sdkVersions(sdk: AppSdk): string {
  const v = sdk.versions ?? [];
  if (v.length === 0) return sdk.name;
  if (v.length === 1) return `${sdk.name} ${v[0]}`;
  return `${sdk.name} ${v[0]} to ${v[v.length - 1]}`;
}

/** How far back an SDK instance still counts as running: instances seen in the last 24 hours. */
export const INSTANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The instances seen in the last 24 hours, or null when the server listed none (older servers). */
export function recentInstances<T extends Pick<AppInstance, "last_seen_at">>(instances: T[] | null | undefined, now: number): T[] | null {
  if (!instances || instances.length === 0) return null;
  return instances.filter((i) => {
    const t = Date.parse(i.last_seen_at);
    return !Number.isNaN(t) && now - t <= INSTANCE_WINDOW_MS;
  });
}

/**
 * The update hint of an SDK, or null when every instance runs the latest release (or none is known).
 * Given the app's listed instances it counts only the outdated ones seen in the last 24 hours, so a
 * process long gone does not keep asking for an update; without them it trusts the server's count.
 */
export function sdkUpdate(
  sdk: AppSdk,
  instances?: Pick<AppInstance, "sdk_name" | "sdk_outdated" | "last_seen_at">[] | null,
  now = Date.now(),
): string | null {
  if (!sdk.latest_version) return null;
  const recent = recentInstances(instances, now);
  const n = recent === null ? sdk.outdated_instances : recent.filter((i) => i.sdk_name === sdk.name && i.sdk_outdated).length;
  if (n <= 0) return null;
  return `Update available: ${sdk.latest_version} (${n} ${n === 1 ? "instance" : "instances"} behind)`;
}

/** `3 instances in the last 24 h`, or null when the server listed none. */
export function instanceCountText(instances: Pick<AppInstance, "last_seen_at">[] | null | undefined, now: number): string | null {
  const recent = recentInstances(instances, now);
  if (recent === null) return null;
  const n = recent.length;
  return `${n} ${n === 1 ? "instance" : "instances"} in the last 24 h`;
}

/** Why an app needs attention: its 5xx share (failing or degraded), or its SDKs stopped reporting. */
export type AttentionReason = "failing" | "degraded" | "not-reporting";

/** What the attention helpers read of a card: its health (null when traffic could not be read) and reporting state. */
export interface AttentionInput {
  health: AppHealth | null;
  reporting: AppReporting | null;
}

/**
 * The reasons an app needs attention: failing or degraded by its 5xx share over the cards' range,
 * and not reporting when no heartbeat arrived in the last 2 minutes (stale or silent; an app that
 * never reported is not counted, nor one whose reads failed).
 */
export function attentionReasons({ health, reporting }: AttentionInput): AttentionReason[] {
  const out: AttentionReason[] = [];
  if (health === "failing" || health === "degraded") out.push(health);
  if (reporting === "stale" || reporting === "silent") out.push("not-reporting");
  return out;
}

const REASON_LABEL: Record<AttentionReason, string> = { failing: "failing", degraded: "degraded", "not-reporting": "not reporting" };

/**
 * The header's attention sentence: `2 apps need attention: 1 failing, 2 not reporting.`. Apps are
 * counted once in the total; each reason counts every app it applies to. "" when none needs it.
 */
export function attentionText(apps: AttentionInput[]): string {
  const reasons = apps.map(attentionReasons);
  const total = reasons.filter((r) => r.length > 0).length;
  if (total === 0) return "";
  const parts = (["failing", "degraded", "not-reporting"] as const)
    .map((r) => ({ r, n: reasons.filter((rs) => rs.includes(r)).length }))
    .filter(({ n }) => n > 0)
    .map(({ r, n }) => `${n} ${REASON_LABEL[r]}`);
  return `${total} ${total === 1 ? "app needs" : "apps need"} attention: ${parts.join(", ")}.`;
}

/** How bad an app looks, worst (0) first: failing, degraded, not reporting, then the rest (healthy, no traffic, unknown). */
export function attentionRank({ health, reporting }: AttentionInput): number {
  if (health === "failing") return 0;
  if (health === "degraded") return 1;
  if (reporting === "stale" || reporting === "silent") return 2;
  return 3;
}

/** Apps sorted worst first; the sort is stable, so apps of equal severity keep their order. */
export function sortBySeverity<T>(apps: T[], of: (a: T) => AttentionInput): T[] {
  return apps
    .map((a, i) => ({ a, i, rank: attentionRank(of(a)) }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((x) => x.a);
}

export const APPS_LOAD_FAILED = "We couldn’t load this project’s apps just now.";
export const STATUS_LOAD_FAILED = "SDK status unavailable.";
export const TRAFFIC_LOAD_FAILED = "Traffic unavailable.";

// One app's page (#995): its overview over the same range as the cards.

/** How many endpoints, deploys and SDK instances the app's page lists. */
export const APP_TOP_ENDPOINTS = 10;
export const APP_RECENT_DEPLOYS = 5;
export const APP_INSTANCES_SHOWN = 10;
/** The range the app's page reads its recent deploys over. */
export const APP_DEPLOYS_RANGE: QueryRange = "7d";

/**
 * Whether the app has sent nothing yet: no requests in the range and no SDK heartbeat ever. Its
 * page then shows how to set the SDK up instead of empty tiles. Unknown (a read failed) is not empty.
 */
export function appIsEmpty(summary: Pick<TrafficSummary, "requests"> | null, status: Pick<AppStatus, "status"> | null): boolean {
  return summary !== null && status !== null && summary.requests <= 0 && status.status === "never";
}

/** An instance's SDK: `apilens-python 0.4.0`. */
export function instanceSdk(i: Pick<AppInstance, "sdk_name" | "sdk_version">): string {
  return i.sdk_version ? `${i.sdk_name} ${i.sdk_version}` : i.sdk_name;
}

/** An instance's release and commit: `2026.11.05 (3f9a2c1)`, either alone, or "" when neither is configured. */
export function instanceRelease(i: Pick<AppInstance, "release" | "commit">): string {
  const commit = /^[0-9a-f]{8,}$/i.test(i.commit) ? i.commit.slice(0, 7) : i.commit;
  if (i.release && commit) return `${i.release} (${commit})`;
  return i.release || commit;
}

export const DEPLOYS_LOAD_FAILED = "Deploys unavailable.";
export const ENDPOINTS_LOAD_FAILED = "Endpoints unavailable.";
