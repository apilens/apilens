// The invite chip input (#346), shared by the organization invite dialog and onboarding's
// 'Invite your team' step (#336): what was typed or pasted becomes one chip per address, each
// with its own role, checked one by one. Invalid entries stay as red chips so the person can see
// and remove them; nothing is sent while one is left. Pure; safe in Client Components and Server
// Actions alike.
import type { InviteEntry, InviteRole } from "./identity";

/** Most addresses one invite request takes (`maxItems` of `invites`). */
export const MAX_INVITES = 50;

/** The roles an invitation can carry, the default first. */
export const INVITE_ROLES: readonly InviteRole[] = ["member", "viewer", "admin"];

/** One address in the input. */
export interface InviteChip {
  /** Lower-cased when it is an address, as typed otherwise. */
  email: string;
  role: InviteRole;
  /** Whether `email` looks like an address. */
  valid: boolean;
  /** Why the server refused this address ("already in Acme"), shown on the chip; unset when none. */
  problem?: string;
}

// A pragmatic address check: something@label.tld, no spaces. The API validates for real.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether `email` looks like an address worth sending. */
export function isEmail(email: string): boolean {
  return email.length <= 320 && EMAIL.test(email);
}

/**
 * The entries of typed or pasted text (`a@example.com, b@example.com`, one per line, or
 * `Ada <ada@example.com>` style brackets): split on commas, semicolons, spaces and new lines.
 */
export function splitInviteText(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((raw) => raw.replace(/^<|>$/g, "").trim())
    .filter(Boolean);
}

/**
 * `chips` with the entries of `text` appended, each with `role`. Addresses are lower-cased and
 * an address already in the list is not added twice; entries that are not addresses are kept
 * (once) and marked invalid.
 */
export function addInviteChips(chips: readonly InviteChip[], text: string, role: InviteRole): InviteChip[] {
  const next = [...chips];
  for (const entry of splitInviteText(text)) {
    const lower = entry.toLowerCase();
    const valid = isEmail(lower);
    const email = valid ? lower : entry;
    if (next.some((c) => c.email.toLowerCase() === lower)) continue;
    next.push({ email, role, valid });
  }
  return next;
}

/** What blocks sending `chips`, or null when they can go. */
export function inviteChipsError(chips: readonly InviteChip[]): string | null {
  const bad = chips.find((c) => !c.valid);
  if (bad) return `“${bad.email}” isn’t an email address. Remove it or fix it.`;
  const refused = chips.find((c) => c.problem);
  if (refused) return `“${refused.email}” can’t be invited: ${refused.problem}. Remove it to send the rest.`;
  if (chips.length === 0) return "Enter at least one email address.";
  if (chips.length > MAX_INVITES) return `Invite at most ${MAX_INVITES} people at a time.`;
  return null;
}

/** The request entries for `chips` (valid ones only). */
export function inviteEntries(chips: readonly InviteChip[]): InviteEntry[] {
  return chips.filter((c) => c.valid).map(({ email, role }) => ({ email, role }));
}

/** The send button's label for `count` addresses. */
export function sendInvitesLabel(count: number): string {
  return count > 1 ? `Send ${count} invitations` : "Send invitation";
}
