// Project settings → API keys (#350): the rules the create dialog checks before it calls
// `POST /projects/{slug}/api-keys`, how each key's status is described, and the sentences shown
// for the server's error codes. The server stays the authority; these checks only spare a round
// trip. Pure; safe in Client Components and Server Actions alike.
import type { ApiKey, ApiKeyScope, KeyApp } from "./identity";
import type { PageOptions } from "./pagination";

/** The section of project settings that lists the keys. */
export const KEYS_SECTION = "keys";

/** `/<project>/settings/keys`. */
export function keysPath(project: string): string {
  return `/${project}/settings/${KEYS_SECTION}`;
}

/** Longest key name the API accepts (`maxLength` of `CreateAPIKeyInputBody.name`). */
export const MAX_KEY_NAME = 100;

/** Every scope, in the order the API lists them, with what it lets a key do. */
export const SCOPES: readonly { value: ApiKeyScope; label: string; help: string }[] = [
  { value: "ingest", label: "Ingest", help: "Send requests, traces and logs from your SDK." },
  { value: "read", label: "Read", help: "Query this project’s data from scripts and the API." },
];

/** Key ids are UUIDs (`format: uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isKeyId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** Project slugs, as the API allows them. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isProjectSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG.test(slug);
}

/** The name as it will be saved, or why it cannot be. */
export function checkKeyName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if ([...name].length > MAX_KEY_NAME) return { ok: false, error: `Use at most ${MAX_KEY_NAME} characters.` };
  return { ok: true, name };
}

/** The scopes as the API wants them (known, deduplicated, in API order), or why they cannot be. */
export function checkScopes(list: unknown): { ok: true; scopes: ApiKeyScope[] } | { ok: false; error: string } {
  const picked = Array.isArray(list) ? list : [];
  const scopes = SCOPES.map((s) => s.value).filter((s) => picked.includes(s));
  if (scopes.length === 0 || picked.some((s) => !scopes.includes(s))) return { ok: false, error: "Choose what the key may do." };
  return { ok: true, scopes };
}

/** The expiry choices of the create dialog. `custom` reveals a date field. */
export type ExpiryChoice = "never" | "30" | "90" | "365" | "custom";

export const EXPIRY_CHOICES: readonly { value: ExpiryChoice; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In 1 year" },
  { value: "custom", label: "On a date…" },
];

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today as `YYYY-MM-DD` in UTC: the earliest a custom expiry date can't be. */
export function todayUTC(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * When a key with `choice` stops working, as the API's `expires_at` (`undefined` for never), or
 * why it cannot. A custom `date` (`YYYY-MM-DD`) means the key works through the end of that day,
 * UTC, and must be after today.
 */
export function expiryFor(
  choice: ExpiryChoice,
  date: string,
  now = Date.now(),
): { ok: true; expiresAt: string | undefined } | { ok: false; error: string } {
  if (choice === "never") return { ok: true, expiresAt: undefined };
  if (choice === "custom") {
    const m = DATE.exec(date);
    const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59) : Number.NaN;
    if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) return { ok: false, error: "Pick a date." };
    if (date <= todayUTC(now)) return { ok: false, error: "Pick a date after today." };
    return { ok: true, expiresAt: new Date(t).toISOString() };
  }
  const days = Number(choice);
  if (!Number.isInteger(days) || days <= 0) return { ok: false, error: "Pick when the key expires." };
  return { ok: true, expiresAt: new Date(now + days * DAY_MS).toISOString() };
}

/** Checks an `expires_at` a Server Action received: absent, or an instant in the future. */
export function checkExpiresAt(value: unknown, now = Date.now()): { ok: true; expiresAt: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, expiresAt: undefined };
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(t)) return { ok: false, error: "Pick when the key expires." };
  if (t <= now) return { ok: false, error: "Pick a date after today." };
  return { ok: true, expiresAt: new Date(t).toISOString() };
}

export type KeyStatus = "active" | "expired" | "revoked";

/** Revoked wins over expired; a key past its `expires_at` is expired. */
export function keyStatus(key: Pick<ApiKey, "revoked_at" | "expires_at">, now = Date.now()): KeyStatus {
  if (key.revoked_at) return "revoked";
  if (key.expires_at) {
    const t = Date.parse(key.expires_at);
    if (!Number.isNaN(t) && t <= now) return "expired";
  }
  return "active";
}

export const STATUS_LABEL: Record<KeyStatus, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };

/** `Ingest, Read`. */
export function scopesLabel(scopes: readonly string[] | null | undefined): string {
  const list = scopes ?? [];
  return SCOPES.filter((s) => list.includes(s.value))
    .map((s) => s.label)
    .join(", ");
}

/** The `prefix` with an ellipsis, so it reads as the start of a longer key. */
export function maskedKey(prefix: string): string {
  return `${prefix}…`;
}

/** Puts a key that was just created first, as the API lists newest first. */
export function withCreated(list: readonly ApiKey[], key: ApiKey): ApiKey[] {
  return [key, ...list.filter((k) => k.id !== key.id)];
}

/** The sentence the keys page shows for an API error `code`. */
export function apiKeysError(code: string): string {
  switch (code) {
    case "api_key_gone":
      return "That key no longer exists. Reload the page to see the current keys.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check the name, scopes, apps and expiry, and try again.";
    case "forbidden":
      return "You don’t have permission to manage this project’s API keys.";
    case "not_found":
      return "This project no longer exists, or you’re no longer a member.";
    case "rate_limited":
      return "Too many changes in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/** The sentence for a failed access change: the API's `invalid_request` names an unknown app. */
export function accessError(code: string): string {
  if (code === "invalid_request") return "One of the apps no longer exists. Reload the page and choose again.";
  return apiKeysError(code);
}

// ---------------------------------------------------------------------------------------------
// Apps a key may send data for, and whether its data creates apps ("apps come from the SDK").

/** One line under "Can create apps" in the create and edit dialogs. */
export const CREATE_APPS_HELP = "When this key sends data with an app name the project doesn’t have yet, APILens creates the app.";
/** Why "Can create apps" is off while the key is limited to apps. */
export const LIMITED_NO_CREATE = "Keys limited to apps never create apps: data with any other app name is rejected.";

/** What a key may do with apps: every app (creating new ones or not), or only the listed ones. */
export interface KeyAccess {
  canCreateApps: boolean;
  /** null: every app. */
  appIds: string[] | null;
}

/** The access a key has as listed. A key limited to apps never creates apps, whatever the flag says. */
export function accessOf(key: Pick<ApiKey, "can_create_apps" | "app_ids">): KeyAccess {
  const ids = key.app_ids ?? null;
  return { canCreateApps: ids === null ? Boolean(key.can_create_apps) : false, appIds: ids };
}

/** Whether a key sends data (its app access matters only then). */
export function isIngestKey(key: Pick<ApiKey, "scopes">): boolean {
  return (key.scopes ?? []).includes("ingest");
}

/** `Limited to 1 app`, `Limited to 3 apps`. */
const limitedTo = (n: number) => `Limited to ${n} ${n === 1 ? "app" : "apps"}`;

/**
 * The permissions column: `Ingest · Can create apps`, `Ingest · Existing apps only`,
 * `Ingest, Read · Limited to 2 apps`, `Read`. App access is shown only for ingest keys.
 */
export function permissionSummary(key: Pick<ApiKey, "scopes" | "can_create_apps" | "app_ids">): string {
  const scopes = scopesLabel(key.scopes);
  if (!isIngestKey(key)) return scopes || "No access";
  const a = accessOf(key);
  const apps = a.appIds !== null ? limitedTo(a.appIds.length) : a.canCreateApps ? "Can create apps" : "Existing apps only";
  return `${scopes} · ${apps}`;
}

/** Names for app ids, from the project's apps. */
export type AppNames = ReadonlyMap<string, string>;

/** At most this many names before "and N more". */
export const NAMES_SHOWN = 3;

/** `Checkout API`, `Checkout API and Orders`, `A, B, C and 2 more`. */
export function nameList(names: readonly string[], shown = NAMES_SHOWN): string {
  if (names.length <= shown) {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/**
 * The app scope column: `All apps` for a key not limited to apps, else the allowed apps' names
 * (an id the project no longer lists reads `a removed app`). Empty for a key that sends nothing.
 */
export function appScopeText(key: Pick<ApiKey, "scopes" | "app_ids">, names: AppNames): string {
  if (!isIngestKey(key)) return "";
  const ids = key.app_ids ?? null;
  if (ids === null) return "All apps";
  if (ids.length === 0) return "No apps";
  const known = ids.map((id) => names.get(id)).filter((n): n is string => Boolean(n));
  const missing = ids.length - known.length;
  const all = missing > 0 ? [...known, missing === 1 ? "a removed app" : `${missing} removed apps`] : known;
  return nameList(all);
}

/** The apps a key has sent data for, most recent first; `apps_seen` may be null. */
export function appsSeen(key: Pick<ApiKey, "apps_seen">): KeyApp[] {
  return [...(key.apps_seen ?? [])].sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
}

/** The ids as the API wants them (UUIDs, deduplicated, in the given order; null for every app), or why not. */
export function checkAppIds(list: unknown): { ok: true; appIds: string[] | null } | { ok: false; error: string } {
  if (list === null || list === undefined) return { ok: true, appIds: null };
  if (!Array.isArray(list)) return { ok: false, error: "Choose the apps the key may send data for." };
  const ids = [...new Set(list)];
  if (ids.length === 0) return { ok: false, error: "Choose at least one app, or allow every app." };
  if (!ids.every((id) => isKeyId(id))) return { ok: false, error: "One of the apps no longer exists. Reload the page and choose again." };
  return { ok: true, appIds: ids as string[] };
}

/** The body of `PUT .../access` (and the access fields of a create) for what the dialog shows. */
export function accessBody(a: KeyAccess): { can_create_apps: boolean; app_ids: string[] | null } {
  return a.appIds === null ? { can_create_apps: a.canCreateApps, app_ids: null } : { can_create_apps: false, app_ids: a.appIds };
}

/** What a reader without key permissions sees instead of the create, edit and revoke controls. */
export const KEYS_READ_ONLY = "You can see this project’s keys but not change them. Project owners, admins and members can create, edit and revoke keys.";

/** The app name the snippet after creating a key shows. */
export const APP_NAME_PLACEHOLDER = "your-service-name";

/**
 * The lines to copy after creating a key: the key and an app name. A key limited to apps names
 * its first allowed app (any other name is rejected); otherwise a placeholder to replace.
 */
export function revealSnippet(raw: string, access: KeyAccess, slugs: ReadonlyMap<string, string>): string {
  const first = access.appIds?.map((id) => slugs.get(id)).find(Boolean);
  return [`export APILENS_API_KEY=${raw}`, `export APILENS_APP_ID=${first ?? APP_NAME_PLACEHOLDER}`].join("\n");
}

/** The sentence under that snippet: what the app name does for this key. */
export function revealAppHint(access: KeyAccess): string {
  if (access.appIds !== null) return "Use the name of an app this key is limited to; data with any other app name is rejected.";
  if (!access.canCreateApps) return "Use the name of an app the project already has: this key doesn’t create apps. Without a name, data goes to the project’s default app.";
  return "Name your service with APILENS_APP_ID (or app_id in the SDK config). The app appears in Apps automatically when its first data arrives; without a name, data goes to the project’s default app.";
}

/** The keys list's page sizes. */
export const KEYS_PAGE: PageOptions = { sizes: [25, 50, 100], defaultPer: 25 };
