// Project settings → API keys (#350): the rules the create dialog checks before it calls
// `POST /projects/{slug}/api-keys`, how each key's status is described, and the sentences shown
// for the server's error codes. The server stays the authority; these checks only spare a round
// trip. Pure; safe in Client Components and Server Actions alike.
import type { ApiKey, ApiKeyScope, Environment, KeyApp, RotateOverlap } from "./identity";
import type { PageOptions } from "./pagination";

/** The Access tab that lists the keys; `/<project>/settings/keys` redirects to it (#801). */
export const KEYS_SECTION = "keys";

/** `/<project>/access/keys`. */
export function keysPath(project: string): string {
  return `/${project}/access/${KEYS_SECTION}`;
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

// ---------------------------------------------------------------------------------------------
// The State column and its filter (#810): Active, Expires in 5 days, Rotating until 14 Nov,
// Expired, Revoked. Expired and revoked keys are "inactive" and stay behind "Show inactive".

/** A working key that expires within this many days reads "Expires in N days". */
export const EXPIRING_SOON_DAYS = 7;

export type KeyState = "active" | "expiring" | "rotating" | "expired" | "revoked";

const HOUR_MS = 3_600_000;
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** `14 Nov` (UTC), as the State column names the end of a rotation. */
export function formatDayMonth(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : DAY_MONTH.format(t);
}

/**
 * A key's state: revoked wins, then expired; a key replaced in a rotation (`rotated_to`) works
 * until its `expires_at` (the overlap) and is "rotating"; a working key that expires within
 * `EXPIRING_SOON_DAYS` is "expiring"; anything else is active.
 */
export function keyState(key: Pick<ApiKey, "revoked_at" | "expires_at" | "rotated_to">, now = Date.now()): KeyState {
  const status = keyStatus(key, now);
  if (status !== "active") return status;
  const t = key.expires_at ? Date.parse(key.expires_at) : Number.NaN;
  if (key.rotated_to && !Number.isNaN(t)) return "rotating";
  if (!Number.isNaN(t) && t - now <= EXPIRING_SOON_DAYS * DAY_MS) return "expiring";
  return "active";
}

/** `Expires in 5 days`, `Expires in 1 day`, `Expires in 3 hours`, `Expires in under an hour`. */
export function expiresInText(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now;
  if (Number.isNaN(left) || left < HOUR_MS) return "Expires in under an hour";
  if (left < DAY_MS) {
    const h = Math.floor(left / HOUR_MS);
    return `Expires in ${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(left / DAY_MS);
  return `Expires in ${d} ${d === 1 ? "day" : "days"}`;
}

/** The State column's words for a key. */
export function keyStateLabel(key: Pick<ApiKey, "revoked_at" | "expires_at" | "rotated_to">, now = Date.now()): string {
  const state = keyState(key, now);
  if (state === "rotating") return `Rotating until ${formatDayMonth(key.expires_at as string)}`;
  if (state === "expiring") return expiresInText(key.expires_at as string, now);
  return STATE_LABEL[state];
}

/** The filter's names for each state. */
export const STATE_LABEL: Record<KeyState, string> = { active: "Active", expiring: "Expiring soon", rotating: "Rotating", expired: "Expired", revoked: "Revoked" };

/** Expired and revoked keys no longer work: they are listed only with "Show inactive". */
export function isInactive(state: KeyState): boolean {
  return state === "expired" || state === "revoked";
}

/** The URL parameters of the filter: `?state=` and `?inactive=1`. */
export const STATE_PARAM = "state";
export const INACTIVE_PARAM = "inactive";

/** The state filter, in the order the menu offers it; `all` is every state the toggle shows. */
export type StateFilter = "all" | KeyState;
export const STATE_FILTERS: readonly StateFilter[] = ["all", "active", "expiring", "rotating", "expired", "revoked"];

export interface KeyFilter {
  state: StateFilter;
  /** Show expired and revoked keys. A state filter of `expired` or `revoked` implies it. */
  inactive: boolean;
}

/** The filter the URL names; anything unknown reads as every working key. */
export function parseKeyFilter(params: Record<string, string | string[] | undefined> | URLSearchParams): KeyFilter {
  const read = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  const raw = read(STATE_PARAM);
  const state = STATE_FILTERS.find((s) => s === raw) ?? "all";
  return { state, inactive: read(INACTIVE_PARAM) === "1" || isInactive(state as KeyState) };
}

/** The keys the filter shows, in the list's order. */
export function filterKeys<K extends Pick<ApiKey, "revoked_at" | "expires_at" | "rotated_to">>(keys: readonly K[], filter: KeyFilter, now = Date.now()): K[] {
  return keys.filter((k) => {
    const s = keyState(k, now);
    if (isInactive(s) && !filter.inactive) return false;
    return filter.state === "all" || filter.state === s;
  });
}

/** How many keys "Show inactive" would add. */
export function inactiveCount(keys: readonly Pick<ApiKey, "revoked_at" | "expires_at" | "rotated_to">[], now = Date.now()): number {
  return keys.filter((k) => isInactive(keyState(k, now))).length;
}

// ---------------------------------------------------------------------------------------------
// The "Can" column (#810): what a key can do and its app and environment limits, in words.

/** `Ingest, create apps and read`, `Ingest`, `Read`. Creating apps applies only to ingest keys not limited to apps. */
export function abilitiesText(key: Pick<ApiKey, "scopes" | "can_create_apps" | "app_ids">): string {
  const scopes = key.scopes ?? [];
  const parts: string[] = [];
  if (scopes.includes("ingest")) parts.push("ingest");
  if (isIngestKey(key) && accessOf(key).canCreateApps) parts.push("create apps");
  if (scopes.includes("read")) parts.push("read");
  if (parts.length === 0) return "No access";
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * The limits under it: `All apps · All environments`, `Only Checkout API · Only production and
 * staging`. Empty for a key that sends no data (limits apply to ingest only).
 */
export function limitsText(key: Pick<ApiKey, "scopes" | "app_ids" | "environments">, names: AppNames): string {
  if (!isIngestKey(key)) return "";
  const ids = key.app_ids ?? null;
  const apps = ids === null ? "All apps" : ids.length === 0 ? "No apps" : `Only ${appScopeText(key, names)}`;
  const envs = key.environments ?? null;
  const env = envs === null || envs.length === 0 ? "All environments" : `Only ${nameList(envs)}`;
  return `${apps} · ${env}`;
}

// ---------------------------------------------------------------------------------------------
// Created and Last used columns (#810).

/** `Just now`, `5 minutes ago`, `3 hours ago`, `Yesterday`, `12 days ago`, then the day. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ago = Math.max(0, now - t);
  if (ago < 60_000) return "Just now";
  if (ago < HOUR_MS) {
    const m = Math.floor(ago / 60_000);
    return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  }
  if (ago < DAY_MS) {
    const h = Math.floor(ago / HOUR_MS);
    return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  }
  const d = Math.floor(ago / DAY_MS);
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d} days ago`;
  return DAY_FULL.format(t);
}

const DAY_FULL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** `apilenss/0.5.0` → `apilenss 0.5.0`; the SDK the key last sent data with. */
export function sdkText(sdk: string | null | undefined): string {
  if (!sdk) return "";
  return sdk.replace("/", " ");
}

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

// ---------------------------------------------------------------------------------------------
// Rotation with an overlap window (#811, D6): a new key replaces the old one, which keeps working
// for the overlap (never past its own expiry) so services can switch over without downtime.

/** The overlap choices of the rotate dialog, in order. */
export const ROTATE_OVERLAPS: readonly { value: RotateOverlap; label: string; help: string }[] = [
  { value: "none", label: "Stop now", help: "The old key is rejected as soon as the new one exists." },
  { value: "24h", label: "24 hours", help: "Enough to redeploy your services with the new key." },
  { value: "7d", label: "7 days", help: "For keys used in many places or by other teams." },
];

/** The overlap the rotate dialog starts with. */
export const DEFAULT_OVERLAP: RotateOverlap = "24h";

const OVERLAP_MS: Record<RotateOverlap, number> = { none: 0, "24h": DAY_MS, "7d": 7 * DAY_MS };

/** Whether a Server Action received a known overlap. */
export function isRotateOverlap(value: unknown): value is RotateOverlap {
  return typeof value === "string" && Object.hasOwn(OVERLAP_MS, value);
}

/** A key can be rotated while it works and has not been rotated already (active or expiring). */
export function canRotate(key: Pick<ApiKey, "revoked_at" | "expires_at" | "rotated_to">, now = Date.now()): boolean {
  const state = keyState(key, now);
  return state === "active" || state === "expiring";
}

/**
 * When the old key stops working if rotated now with `overlap`, as the API computes it: now plus
 * the overlap, but never later than the key's own `expires_at`.
 */
export function overlapEnd(overlap: RotateOverlap, expiresAt: string | null, now = Date.now()): number {
  const end = now + OVERLAP_MS[overlap];
  const own = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isNaN(own) ? end : Math.min(end, own);
}

const DAY_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** `14 Nov, 10:30 UTC`. */
export function formatDayTime(t: number): string {
  return Number.isNaN(t) ? "" : `${DAY_TIME.format(t)} UTC`;
}

/** The sentence under the overlap choices: what happens to the old key. */
export function overlapText(overlap: RotateOverlap, expiresAt: string | null, now = Date.now()): string {
  if (overlap === "none") return "The old key stops working as soon as you rotate.";
  const end = overlapEnd(overlap, expiresAt, now);
  const capped = end < now + OVERLAP_MS[overlap];
  return `The old key keeps working until ${formatDayTime(end)}${capped ? ", when it expires anyway" : ""}.`;
}

/** The status line after a rotation, from the rotated key as the API answered it. */
export function rotatedText(previous: Pick<ApiKey, "name" | "expires_at">, now = Date.now()): string {
  const end = previous.expires_at ? Date.parse(previous.expires_at) : Number.NaN;
  if (Number.isNaN(end) || end <= now) return `Rotated ${previous.name}. The old key no longer works.`;
  return `Rotated ${previous.name}. The old key works until ${formatDayTime(end)}.`;
}

/** The list after a rotation: the new key first, the old one replaced by its rotated row. */
export function withRotated(list: readonly ApiKey[], next: ApiKey, previous: ApiKey): ApiKey[] {
  return withCreated(
    list.map((k) => (k.id === previous.id ? previous : k)),
    next,
  );
}

/** The sentence for a failed rotation: `key_not_active` means it was revoked, expired or rotated meanwhile. */
export function rotateError(code: string): string {
  if (code === "key_not_active") return "This key was revoked, expired or rotated already. Reload the page to see the current keys.";
  return apiKeysError(code);
}

// ---------------------------------------------------------------------------------------------
// Environment limits of a new key (#811, after #774): every environment, or only the ones picked.

/** The environments a key can be pinned to: the project's visible ones, in the project's order. */
export function pickableEnvironments(list: readonly Pick<Environment, "name" | "hidden" | "position">[] | null): string[] | null {
  if (list === null) return null;
  return [...list]
    .filter((e) => !e.hidden)
    .sort((a, b) => a.position - b.position)
    .map((e) => e.name);
}

/** The environments as the API wants them (deduplicated names; null for every environment), or why not. */
export function checkEnvironments(list: unknown): { ok: true; environments: string[] | null } | { ok: false; error: string } {
  if (list === null || list === undefined) return { ok: true, environments: null };
  if (!Array.isArray(list) || !list.every((n) => typeof n === "string" && n.trim() !== "")) return { ok: false, error: "Choose the environments the key may send data for." };
  const names = [...new Set(list.map((n: string) => n.trim()))];
  if (names.length === 0) return { ok: false, error: "Choose at least one environment, or allow every environment." };
  return { ok: true, environments: names };
}
