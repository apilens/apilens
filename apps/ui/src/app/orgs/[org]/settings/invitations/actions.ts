"use server";

// Server Actions of the organization invitations page (#346). Each one re-checks its input (a
// Server Action is a public POST endpoint), calls the API as the signed-in user, revalidates the
// page so the list re-renders from the server, and answers a sentence to show, never a raw
// error. Authorization and the 5-minute resend cooldown are the API's.
import { revalidatePath } from "next/cache";
import { identity, isApiError } from "@/lib/identity";
import { invitationsError } from "@/lib/invitations";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type InvitationActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      error: string;
      code?: string;
      /** Seconds until a resend is allowed (`rate_limited`). */
      retryAfter?: number;
    };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const valid = (slug: unknown, id: unknown) => typeof slug === "string" && SLUG.test(slug) && typeof id === "string" && UUID.test(id);
const invalid = (): InvitationActionResult => ({ ok: false, error: invitationsError("invalid_request"), code: "invalid_request" });
const who = (email: unknown) => (typeof email === "string" && email ? email : "the invitee");

/** Runs `call` as the signed-in user, then revalidates the invitations page. */
async function run(slug: string, call: (session: ServerSession) => Promise<unknown>, message: string): Promise<InvitationActionResult> {
  const page = `/orgs/${slug}/settings/invitations`;
  return withActionSession(async (session) => {
    try {
      await call(session);
    } catch (err) {
      if (!isApiError(err)) throw err;
      // Accepted or revoked meanwhile: show the fresh list along with the sentence.
      if (err.code === "invite_expired") revalidatePath(page);
      return { ok: false, error: invitationsError(err.code), code: err.code, retryAfter: err.retryAfter ?? undefined };
    }
    revalidatePath(page);
    return { ok: true, message };
  });
}

/** Emails the invitation again with a new link. `email` is only used in the sentence shown afterwards. */
export async function resendInvitation(slug: string, id: string, email: string): Promise<InvitationActionResult> {
  if (!valid(slug, id)) return invalid();
  return run(slug, (s) => s.call((o) => identity().resendInvitation(slug, id, o)), `Invitation resent to ${who(email)}.`);
}

/** Revokes the invitation; its link stops working. */
export async function revokeInvitation(slug: string, id: string, email: string): Promise<InvitationActionResult> {
  if (!valid(slug, id)) return invalid();
  return run(slug, (s) => s.call((o) => identity().revokeInvitation(slug, id, o)), `Invitation to ${who(email)} revoked.`);
}
