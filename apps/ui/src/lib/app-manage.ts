// Managing a project's apps on the Apps page: apps come from the SDK (an unknown app name creates
// the app the first time an SDK sends it), so the page says where each app came from, flags new
// ones, explains rejected records and offers rename, merge, archive, restore and delete
// (`/projects/{slug}/apps`). Pure helpers, unit-tested in app-manage.test.ts.
import type { AppRejection, AppRejectionReason, ManagedApp, NamedApp } from "./identity";
import { formatCount } from "./first-data";
import type { PageOptions } from "./pagination";

/** App ids are UUIDs (`format: uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isManagedAppId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** The cards per page of the Apps overview (multiples of 2 and 3, so the grid rows fill). */
export const APPS_PAGE: PageOptions = { sizes: [12, 24, 48], defaultPer: 12 };

/** The days of rejected records the notice covers. */
export const REJECTION_DAYS = 7;

/** Apps in use, the default app first, then by name. */
export function activeApps(apps: readonly ManagedApp[]): ManagedApp[] {
  return apps
    .filter((a) => a.state === "active")
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Archived, merged and deleted apps, the most recently changed first. */
export function inactiveApps(apps: readonly ManagedApp[]): ManagedApp[] {
  const when = (a: ManagedApp) => Date.parse(a.deleted_at ?? a.archived_at ?? a.created_at) || 0;
  return apps.filter((a) => a.state !== "active").sort((a, b) => when(b) - when(a));
}

/** Apps an SDK created in the last 7 days that nobody has kept or merged yet. */
export function newApps(apps: readonly ManagedApp[]): ManagedApp[] {
  return apps.filter((a) => a.state === "active" && a.new && a.created_by === "sdk");
}

/** The apps another app can be merged into: active ones other than itself. */
export function mergeTargets(apps: readonly ManagedApp[], app: Pick<ManagedApp, "id">): ManagedApp[] {
  return activeApps(apps).filter((a) => a.id !== app.id);
}

/**
 * The cards' apps: the managed list's active ones when it was read, else the query role's
 * `GET /project` list (older servers, or when the managed list could not be read).
 */
export function cardApps(managed: readonly ManagedApp[] | null, listed: readonly NamedApp[] | null): NamedApp[] | null {
  if (managed) return activeApps(managed);
  return listed ? [...listed] : null;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** `Nov 6` this year, `Nov 6, 2025` before; empty for a missing or bad date. */
export function shortDay(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).getUTCFullYear() === new Date(now).getUTCFullYear() ? DAY.format(t) : DAY_YEAR.format(t);
}

/**
 * Where an app came from: `Added by the SDK from key prod-backend · Nov 6`, `Added by the SDK ·
 * Nov 6` (no key recorded) or `Added in the dashboard · Nov 6`.
 */
export function originText(app: Pick<ManagedApp, "created_by" | "created_by_key_name" | "created_at" | "first_seen_at">, now = Date.now()): string {
  const day = shortDay(app.created_by === "sdk" ? (app.first_seen_at ?? app.created_at) : app.created_at, now);
  const who = app.created_by === "sdk" ? (app.created_by_key_name ? `Added by the SDK from key ${app.created_by_key_name}` : "Added by the SDK") : "Added in the dashboard";
  return day ? `${who} · ${day}` : who;
}

/** When data last arrived for an app: `Last data just now`, `Last data 3 h ago`, `No data yet`. */
export function lastDataText(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(t)) return "No data yet";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Last data just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `Last data ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Last data ${h} h ago`;
  const d = Math.floor(h / 24);
  return `Last data ${d} ${d === 1 ? "day" : "days"} ago`;
}

/** Whether an archived, merged or deleted app can be restored now (deleted ones until `restorable_until`). */
export function canRestore(app: Pick<ManagedApp, "state" | "restorable_until">, now = Date.now()): boolean {
  if (app.state === "archived" || app.state === "merged") return true;
  if (app.state !== "deleted") return false;
  const until = app.restorable_until ? Date.parse(app.restorable_until) : Number.NaN;
  return !Number.isNaN(until) && until > now;
}

/** Only archived apps can be deleted from the page (archive first, so nothing goes in one click). */
export function canDelete(app: Pick<ManagedApp, "state" | "is_default">): boolean {
  return app.state === "archived" && !app.is_default;
}

export const STATE_LABEL: Record<ManagedApp["state"], string> = { active: "Active", archived: "Archived", merged: "Merged", deleted: "Deleted" };

/** One sentence on what an archived, merged or deleted app means now. */
export function stateText(app: ManagedApp, now = Date.now()): string {
  switch (app.state) {
    case "archived":
      return `Archived${app.archived_at ? ` ${shortDay(app.archived_at, now)}` : ""}. It comes back on its own when its SDK sends data again.`;
    case "merged":
      return `Merged into ${app.merged_into_slug ?? "another app"}. New data for ${app.slug} goes there; earlier data stays under ${app.slug}.`;
    case "deleted":
      return canRestore(app, now)
        ? `Deleted${app.deleted_at ? ` ${shortDay(app.deleted_at, now)}` : ""}. Data for ${app.slug} is rejected until ${shortDay(app.restorable_until, now)}; restore it before then to keep the name.`
        : `Deleted. It can no longer be restored, and the name ${app.slug} is free again.`;
    default:
      return "";
  }
}

/** Longest app name the API accepts (`RenameAppInputBody.name`). */
export const MAX_APP_NAME = 100;

/** The display name as it will be saved, or why it cannot be. */
export function checkAppName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if ([...name].length > MAX_APP_NAME) return { ok: false, error: `Use at most ${MAX_APP_NAME} characters.` };
  return { ok: true, name };
}

/** What merging `from` into `into` does, for the merge dialog. */
export function mergeExplainer(from: Pick<ManagedApp, "slug">, into: Pick<ManagedApp, "name"> | null): string {
  const target = into ? into.name : "the app you pick";
  return `From now on, data an SDK sends as ${from.slug} goes to ${target}. Data already received stays under ${from.slug}; it is not moved or rewritten. You can undo this by restoring ${from.slug}.`;
}

/** The sentence a successful write announces. */
export function doneText(action: "rename" | "archive" | "restore" | "acknowledge" | "merge" | "delete", app: Pick<ManagedApp, "name">, into?: Pick<ManagedApp, "name">): string {
  switch (action) {
    case "rename":
      return `Renamed to ${app.name}. SDKs keep sending the same app name.`;
    case "archive":
      return `Archived ${app.name}. It comes back on its own when its SDK sends data.`;
    case "restore":
      return `Restored ${app.name}.`;
    case "acknowledge":
      return `Kept ${app.name}.`;
    case "merge":
      return `Merged ${app.name} into ${into?.name ?? "the other app"}. Its new data goes there from now on.`;
    case "delete":
      return `Deleted ${app.name}. Data with its name is rejected for 30 days; restore it from Archived before then.`;
  }
}

/** The sentence for a failed app write: the problem's own `detail` for the codes that carry one. */
export function appActionError(code: string, detail?: string | null): string {
  switch (code) {
    case "forbidden":
      return "You don’t have permission to manage this project’s apps. Ask a project admin.";
    case "not_found":
      return "That app no longer exists. Reload the page to see the current apps.";
    case "slug_taken":
      return detail || "A newer app uses this app’s name. Rename or delete that app first.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return detail || "That change wasn’t accepted. Reload the page and try again.";
    case "rate_limited":
      return "Too many changes in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
    case "authz_unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return detail || "Something went wrong. Try again in a moment.";
  }
}

/** Why records were rejected, and what to do about it, per reason. */
export const REJECTION_REASON: Record<AppRejectionReason, { label: string; fix: string }> = {
  app_create_forbidden: {
    label: "the key can’t create apps",
    fix: "Turn on “Can create apps” for the key in Settings → API keys, or send an existing app name.",
  },
  app_not_allowed: {
    label: "the key is limited to other apps",
    fix: "Add the app to the key’s apps in Settings → API keys, or use a key that may send for it.",
  },
  app_deleted: {
    label: "the app was deleted",
    fix: "Restore the app from Archived below to accept its data again.",
  },
  app_limit: {
    label: "the project has reached its app limit",
    fix: "Merge or delete apps you no longer need, or ask your APILens admin to raise the limit (ingest.max_apps_per_project).",
  },
  app_rate_limit: {
    label: "too many new apps in an hour",
    fix: "An SDK may be sending a different name per instance. Use a fixed app name; the limit is ingest.max_new_apps_per_hour.",
  },
  invalid_app_name: {
    label: "the app name isn’t valid",
    fix: "Give the SDK an app name with letters or digits: “Orders API” and “orders-api” both work and name the same app.",
  },
  unknown_app: {
    label: "no app has that id",
    fix: "The SDK sent an app id that matches no app. Send the app’s name instead, for example APILENS_APP_ID=orders-api.",
  },
};

/** The rejections with records, the most records first. */
export function rejectionRows(list: readonly AppRejection[] | null | undefined): AppRejection[] {
  return [...(list ?? [])].filter((r) => r.records > 0).sort((a, b) => b.records - a.records || a.app.localeCompare(b.app));
}

/** `1,204 records were rejected in the last 7 days.` */
export function rejectionHeadline(rows: readonly AppRejection[], days: number): string {
  const total = rows.reduce((n, r) => n + r.records, 0);
  const span = days === 1 ? "today" : `in the last ${days} days`;
  return `${formatCount(total)} ${total === 1 ? "record was" : "records were"} rejected ${span}.`;
}

/** One rejection line: `orders-api: 340 records, the key can’t create apps (last Nov 6).` */
export function rejectionLine(r: AppRejection, now = Date.now()): string {
  const day = shortDay(`${r.last_day}T00:00:00Z`, now);
  const name = r.app || "(no name)";
  return `${name}: ${formatCount(r.records)} ${r.records === 1 ? "record" : "records"}, ${REJECTION_REASON[r.reason]?.label ?? "rejected"}${day ? ` (last ${day})` : ""}.`;
}

/** The distinct fixes for the reasons present, in the order they first appear. */
export function rejectionFixes(rows: readonly AppRejection[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const fix = REJECTION_REASON[r.reason]?.fix;
    if (fix && !out.includes(fix)) out.push(fix);
  }
  return out;
}
