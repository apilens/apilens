// Project settings → API keys (#350): the rules the create dialog checks before it calls
// `POST /projects/{slug}/api-keys`, how each key's status is described, and the sentences shown
// for the server's error codes. The server stays the authority; these checks only spare a round
// trip. Pure; safe in Client Components and Server Actions alike.
import type { ApiKey, ApiKeyScope } from "./identity";

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
      return "Some values weren’t accepted. Check the name, scopes and expiry, and try again.";
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
