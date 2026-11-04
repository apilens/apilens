// Account profile (#340): the rules the `/settings` Profile form and the Danger zone check
// before they call `PATCH /users/me`, `POST /users/me/email/change|confirm` or `DELETE /users/me`,
// and the sentences they show for the server's error codes. The server stays the authority;
// these checks only spare a round trip. Pure; safe in Client Components and Server Actions alike.

/** Longest display name the API accepts (`maxLength` of `MePatchBody.name`). */
export const MAX_NAME = 120;
/** Longest email address the API accepts (`maxLength` of `EmailChangeInputBody.new_email`). */
export const MAX_EMAIL = 254;
/** Digits in an email change code. */
export const CODE_LENGTH = 6;
/** Where the browser goes once the account is deleted (every session is revoked with it). */
export const ACCOUNT_DELETED_PATH = "/sign-in?reason=account_deleted";

// Same shape the sign-in form accepts: something@something.tld, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Checked<K extends string> = ({ ok: true } & Record<K, string>) | { ok: false; error: string };

/** The name as it will be saved, or why it cannot be. */
export function checkName(raw: string): Checked<"name"> {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter your name." };
  if ([...name].length > MAX_NAME) return { ok: false, error: `Use at most ${MAX_NAME} characters.` };
  return { ok: true, name };
}

/** The new address as it will be sent, or why it cannot be. `current` is the account's email. */
export function checkNewEmail(raw: string, current: string): Checked<"email"> {
  const email = raw.trim();
  if (!email) return { ok: false, error: "Enter the new email address." };
  if (email.length > MAX_EMAIL || !EMAIL.test(email)) return { ok: false, error: "Enter an email address like you@example.com." };
  if (email.toLowerCase() === current.trim().toLowerCase()) return { ok: false, error: "That’s already your email address." };
  return { ok: true, email };
}

/** The code without the spaces and hyphens people paste with it. */
export function cleanCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

/** Whether `raw` is a whole 6-digit code once cleaned. */
export function isCode(raw: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(cleanCode(raw));
}

/** Whether the delete confirmation matches the account's email (case and surrounding spaces ignored). */
export function deleteConfirmed(email: string, typed: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase() && email.trim() !== "";
}

/** An organization the user owns, linked to where ownership is transferred or the org deleted. */
export interface OwnedOrg {
  slug: string;
  name: string;
  href: string;
}

/**
 * Organizations the user owns: the ones that can block `DELETE /users/me` with
 * `owner_transfer_required` (the server refuses while the user is the only owner of one).
 */
export function ownedOrgs(orgs: readonly { slug: string; name: string; role: string }[]): OwnedOrg[] {
  return orgs
    .filter((o) => o.role === "owner")
    .map((o) => ({ slug: o.slug, name: o.name, href: `/orgs/${encodeURIComponent(o.slug)}/settings` }));
}

/** The sentence the profile page shows for an API error `code`. */
export function profileError(code: string): string {
  switch (code) {
    case "email_taken":
      return "Another account already uses that email address.";
    case "invalid_code":
      return "That code isn’t right. Check the email and try again.";
    case "code_expired":
      return "This code has expired. Send a new one to continue.";
    case "too_many_attempts":
      return "Too many wrong codes. Send a new one to continue.";
    case "owner_transfer_required":
      return "You’re the only owner of an organization. Transfer its ownership or delete it first.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check them and try again.";
    case "rate_limited":
      return "Too many attempts in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
