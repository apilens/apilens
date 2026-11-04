// Security → Passkeys (#341): the rules the passkey table checks before it calls identity, how it
// describes each passkey, and the sentences it shows for the server's error codes. Pure; safe
// in Client Components and Server Actions alike.
import type { Passkey } from "./identity";
import { PASSKEY_CANCELLED } from "./auth/passkeys";

/** Where passkeys are managed. */
export const SECURITY_SETTINGS_PATH = "/settings/security";

/** Longest passkey name identity accepts (`maxLength` of `PasskeyRenameBody.name`). */
export const MAX_PASSKEY_NAME = 64;

/** Passkey ids are UUIDs (`format: uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPasskeyId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** The name as it will be saved, or why it cannot be. */
export function checkPasskeyName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if ([...name].length > MAX_PASSKEY_NAME) return { ok: false, error: `Use at most ${MAX_PASSKEY_NAME} characters.` };
  return { ok: true, name };
}

/**
 * Who made the authenticator, from its AAGUID (identity resolves it). Without a known model the
 * transports still tell a security key from a phone or a built-in authenticator.
 */
export function passkeyVendor(p: Pick<Passkey, "authenticator" | "transports">): string {
  if (p.authenticator.trim()) return p.authenticator.trim();
  const t = p.transports ?? [];
  if (t.includes("internal")) return "This device’s authenticator";
  if (t.includes("hybrid")) return "Phone or tablet";
  if (t.some((x) => x === "usb" || x === "nfc" || x === "ble")) return "Security key";
  return "Unknown authenticator";
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const EXACT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** `Nov 4, 2026`. UTC so the server render and the browser agree. */
export function formatDay(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : DAY.format(t);
}

/** `Nov 4, 2026, 2:05 PM UTC`, for a tooltip. */
export function formatExact(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : `${EXACT.format(t)} UTC`;
}

/** "Never", "Today", "Yesterday", "5 days ago", or the day for anything older than a month. */
export function formatLastUsed(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Never";
  const days = Math.floor(now / 86_400_000) - Math.floor(t / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDay(iso);
}

/** User-facing copy for a failed add, rename or remove, or `null` when nothing should be shown. */
export function passkeySettingsError(code: string): string | null {
  switch (code) {
    case PASSKEY_CANCELLED:
      return null;
    case "unsupported":
      return "This browser can’t create passkeys. Try a recent version of Chrome, Safari, Edge or Firefox.";
    case "passkey_already_registered":
      return "This authenticator already holds a passkey for your account.";
    case "passkey_failed":
      return "The passkey couldn’t be verified. Try again.";
    case "passkey_gone":
      return "That passkey was already removed.";
    case "validation_failed":
    case "invalid_request":
      return "Enter a name of at most 64 characters.";
    case "rate_limited":
      return "Too many attempts. Try again in a moment.";
    case "network_error":
      return "Couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}
