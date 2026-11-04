"use server";

// Server Actions of the account Profile and Danger zone sections (#340). Each one re-checks its
// input (a Server Action is a public POST endpoint), calls the API as the signed-in user and
// answers a sentence to show, never a raw error.
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { type User, identity, isApiError } from "@/lib/identity";
import { ACCOUNT_DELETED_PATH, checkName, cleanCode, deleteConfirmed, isCode, profileError } from "@/lib/profile";
import { SESSION_COOKIE_NAME } from "@/lib/session-format";
import { withActionSession } from "@/lib/server-session";

export type Failed = { ok: false; error: string; code?: string; retryAfter?: number };
export type ProfileResult = { ok: true; user: User } | Failed;
export type EmailChangeResult = { ok: true; pendingEmail: string; expiresAt: string } | Failed;
export type DeleteAccountResult = { ok: true; next: string; deleteAfter: string } | Failed;

function failed(err: unknown, override?: Partial<Record<string, string>>): Failed {
  if (!isApiError(err)) throw err;
  const out: Failed = { ok: false, error: override?.[err.code] ?? profileError(err.code), code: err.code };
  if (err.retryAfter) out.retryAfter = err.retryAfter;
  return out;
}

/** Saves the display name. */
export async function saveProfileName(name: string): Promise<ProfileResult> {
  const checked = checkName(typeof name === "string" ? name : "");
  if (!checked.ok) return { ok: false, error: checked.error };
  return withActionSession(async (session) => {
    try {
      const user = await session.call((o) => identity().updateMe({ name: checked.name }, o));
      // The name shows in the sidebar's account menu too.
      revalidatePath("/", "layout");
      return { ok: true, user };
    } catch (err) {
      return failed(err);
    }
  });
}

/** Emails a code to `newEmail`; {@link confirmEmailChange} finishes the change. */
export async function requestEmailChange(newEmail: string): Promise<EmailChangeResult> {
  const email = typeof newEmail === "string" ? newEmail.trim() : "";
  // The format is the API's to judge; this only refuses what cannot be an address at all.
  if (!email || email.length > 254 || /\s/.test(email) || !email.includes("@")) {
    return { ok: false, error: "Enter an email address like you@example.com." };
  }
  return withActionSession(async (session) => {
    try {
      const started = await session.call((o) => identity().startEmailChange({ new_email: email }, o));
      return { ok: true, pendingEmail: started.pending_email, expiresAt: started.expires_at };
    } catch (err) {
      // The API answers `invalid_request` when the address is already the user's.
      return failed(err, { invalid_request: "Enter a different email address from the one you use now." });
    }
  });
}

/** Checks the code sent to the new address and makes it the account's email. */
export async function confirmEmailChange(code: string): Promise<ProfileResult> {
  if (typeof code !== "string" || !isCode(code)) return { ok: false, error: "Enter the 6-digit code from the email." };
  return withActionSession(async (session) => {
    try {
      const user = await session.call((o) => identity().confirmEmailChange({ code: cleanCode(code) }, o));
      revalidatePath("/", "layout");
      return { ok: true, user };
    } catch (err) {
      return failed(err);
    }
  });
}

/**
 * Deletes the account once `confirm` repeats its email. The API revokes every session with it,
 * so the session cookie is cleared here and the browser is told where to go (it navigates itself,
 * so client state that belonged to the account goes too).
 */
export async function deleteAccount(confirm: string): Promise<DeleteAccountResult> {
  if (typeof confirm !== "string" || !confirm.trim()) return { ok: false, error: "Type your email address to confirm." };
  const result = await withActionSession(async (session): Promise<DeleteAccountResult> => {
    try {
      // Checked against the account itself, not against anything the browser sent.
      const me = await session.call((o) => identity().me(o));
      if (!deleteConfirmed(me.email, confirm)) return { ok: false, error: `Type ${me.email} to confirm.` };
      const deleted = await session.call((o) => identity().deleteMe(o));
      return { ok: true, next: ACCOUNT_DELETED_PATH, deleteAfter: deleted.delete_after };
    } catch (err) {
      return failed(err);
    }
  });
  if (result.ok) (await cookies()).delete(SESSION_COOKIE_NAME);
  return result;
}
