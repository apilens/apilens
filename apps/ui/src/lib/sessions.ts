// The Sessions section of account settings (#343): ordering, labels and copy for the signed-in
// user's live sessions. Pure; safe in Client Components (types only from identity).
import type { AuthMethod, SessionInfo } from "./identity";

/** The section's path; Server Actions revalidate it after a change. */
export const SESSIONS_PATH = "/settings/sessions";

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The table's rows: the current session pinned first, then the others newest first (most
 * recently active, then most recently signed in). Does not change `sessions`.
 */
export function orderSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      time(b.last_seen_at) - time(a.last_seen_at) ||
      time(b.created_at) - time(a.created_at) ||
      a.id.localeCompare(b.id),
  );
}

/** Whether there is anything for "Sign out other sessions" to end. */
export function hasOtherSessions(sessions: readonly SessionInfo[]): boolean {
  return sessions.some((s) => !s.current);
}

/** The device column: the server's label, or a fallback when the user agent told it nothing. */
export function deviceLabel(s: Pick<SessionInfo, "device_label">): string {
  return s.device_label.trim() || "Unknown device";
}

const METHOD_LABELS: Record<AuthMethod, string> = {
  email: "Email code",
  google: "Google",
  github: "GitHub",
  passkey: "Passkey",
  totp: "Authenticator app",
  backup_code: "Backup code",
  sso: "Single sign-on",
};

/** How the session signed in, e.g. "Email code + Authenticator app"; empty when unknown. */
export function signInMethod(amr: readonly string[] | null): string {
  if (!amr) return "";
  const labels = amr.map((m) => (Object.hasOwn(METHOD_LABELS, m) ? METHOD_LABELS[m as AuthMethod] : null));
  return [...new Set(labels.filter((l): l is string => l !== null))].join(" + ");
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "Active now" for the last minute, else "5 minutes ago", "yesterday", "3 weeks ago". */
export function lastActive(iso: string, now: number): string {
  const at = time(iso);
  if (!at) return "Unknown";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "Active now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
  return "Active now";
}

/** An absolute date and time for titles and the "Signed in" column, in UTC so server and browser agree. */
export function formatDateTime(iso: string): string {
  const at = time(iso);
  if (!at) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(at);
}

/** A sentence for a failed session action, by error code. */
export function sessionsError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "That session couldn’t be found. Reload the page and try again.";
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
