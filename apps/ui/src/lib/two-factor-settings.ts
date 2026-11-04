// Security → Two-factor (#342): the copy and formatting behind the account's two-factor card and
// its dialogs (turn on with a QR code, backup codes shown once, turn off, regenerate). Identity
// stays the authority; these only shape what it answers. Pure; safe in Client Components and
// Server Actions alike.

/** At or below this many unused backup codes the card suggests regenerating them. */
export const LOW_BACKUP_CODES = 3;

/** File name of the backup codes download. */
export const BACKUP_CODES_FILE = "apilens-backup-codes.txt";

/** A six-digit authenticator code. */
export function isTotp(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}

/** The base32 secret in groups of four, easier to type into an authenticator app. */
export function groupSecret(secret: string): string {
  return (secret.replace(/[\s=]/g, "").toUpperCase().match(/.{1,4}/g) ?? []).join(" ");
}

/** "8 backup codes left" / "1 backup code left" / "No backup codes left". */
export function backupCodesLeft(n: number): string {
  if (n <= 0) return "No backup codes left";
  return `${n} backup ${n === 1 ? "code" : "codes"} left`;
}

/** "since 4 Nov 2026" for the card, in the viewer's locale; empty for a missing or bad date. */
export function enabledSince(iso: string | null, locale?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `since ${d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * The `.txt` someone downloads with their backup codes: what they are, whose they are, when they
 * were made, then one code per line.
 */
export function backupCodesText(codes: readonly string[], email: string | null, at: Date = new Date()): string {
  const lines = [
    "APILens backup codes",
    ...(email ? [`Account: ${email}`] : []),
    `Generated: ${at.toISOString().slice(0, 10)}`,
    "",
    "Each code signs you in once if you can't use your authenticator app.",
    "Generating new codes makes these stop working.",
    "",
    ...codes,
    "",
  ];
  return lines.join("\n");
}

/** The sentence a dialog shows for an identity error code (sentence case, no exclamation marks). */
export function twoFactorSettingsError(code: string, backup = false): string {
  switch (code) {
    case "invalid_totp":
      return backup ? "That backup code didn’t work. Check it, or use your authenticator app." : "Wrong code. Enter the current code from your authenticator app.";
    case "validation_failed":
    case "invalid_request":
      return backup ? "Enter a backup code like abcd-1234." : "Enter the 6-digit code from your authenticator app.";
    case "reauth_required":
      return "For your security, sign in again before turning on two-factor authentication.";
    case "already_enabled":
      return "Two-factor authentication is already on.";
    case "not_enabled":
      return "Two-factor authentication is already off.";
    case "rate_limited":
      return "Too many attempts. Wait a minute and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}
