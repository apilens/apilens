// Pending invitations (#346): the resend cooldown, expiry and the sentences
// `/orgs/<org>/settings/invitations` shows. The rules mirror internal/controlplane/orgs/invitations.go
// (an invitation is emailed at most once every 5 minutes, counted from `resent_at`, else
// `created_at`) so the Resend button counts down instead of failing; the server stays the
// authority and answers `rate_limited` with `retry_after`. Pure; safe in Client Components and
// Server Actions alike.
import type { Invitation } from "./identity";

/** The least time between two emails of one invitation (`orgs.ResendCooldown`). */
export const RESEND_COOLDOWN_MS = 5 * 60_000;

/** When `inv` was last emailed. */
export function lastSentAt(inv: Pick<Invitation, "created_at" | "resent_at">): number {
  return Date.parse(inv.resent_at ?? inv.created_at);
}

/** Milliseconds until `inv` can be resent at `now` (0 when it can be now). */
export function resendWait(inv: Pick<Invitation, "created_at" | "resent_at">, now: number): number {
  const last = lastSentAt(inv);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, last + RESEND_COOLDOWN_MS - now);
}

/** A wait as `m:ss`, rounded up to the second (`4:05`, `0:09`). */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether the emailed link of `inv` stopped working at `now` (it can still be resent). */
export function isExpired(inv: Pick<Invitation, "expires_at">, now: number): boolean {
  const at = Date.parse(inv.expires_at);
  return !Number.isNaN(at) && at <= now;
}

const DAY = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** A day, the same on the server and in every browser. */
export function formatDay(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "Unknown" : DAY.format(at);
}

/** Who sent `inv`: their name, their email when they have none, or a dash once they are gone. */
export function inviterName(inv: Pick<Invitation, "invited_by">): string {
  const by = inv.invited_by;
  if (!by) return "—";
  return by.name.trim() || by.email;
}

/** The sentence the invitations page shows for an API error `code`. */
export function invitationsError(code: string): string {
  switch (code) {
    case "invite_expired":
      return "That invitation was already accepted or revoked. The list has been refreshed.";
    case "rate_limited":
      return "That invitation was emailed a moment ago. Wait a few minutes before resending it.";
    case "forbidden":
      return "Only owners and admins can manage invitations.";
    case "not_found":
      return "This organization no longer exists, or you’re no longer a member.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check them and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
