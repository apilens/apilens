"use server";

// Server Actions of the organization members page (#345). Each one re-checks its input (a Server
// Action is a public POST endpoint), calls the API as the signed-in user, revalidates the page so
// the table re-renders from the server, and answers a sentence to show, never a raw error.
// Authorization is the API's: role changes and removal need `manage_members`, invitations need
// `invite`, transferring ownership needs an owner.
import { revalidatePath } from "next/cache";
import { type InviteEntry, type InviteResult, type OrgRole, identity, isApiError } from "@/lib/identity";
import { INVITE_ROLES, MAX_INVITES, isEmail } from "@/lib/invite-input";
import { MEMBER_ROLES, inviteSummary, membersError } from "@/lib/org-members";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type MembersActionResult = { ok: true; message: string } | { ok: false; error: string; code?: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (): MembersActionResult => ({ ok: false, error: membersError("invalid_request"), code: "invalid_request" });
const validTarget = (slug: unknown, userId: unknown) =>
  typeof slug === "string" && SLUG.test(slug) && typeof userId === "string" && UUID.test(userId);

/**
 * Runs `call` as the signed-in user, then revalidates the members page, or the whole app when
 * the user's own role changed (the sidebar and every gate read it from the context).
 */
async function run(slug: string, call: (session: ServerSession) => Promise<unknown>, message: string, ownRole = false): Promise<MembersActionResult> {
  const page = `/orgs/${slug}/settings/members`;
  return withActionSession(async (session) => {
    try {
      await call(session);
    } catch (err) {
      if (!isApiError(err)) throw err;
      // Someone else already removed them: show the fresh list along with the sentence.
      if (err.code === "member_gone") revalidatePath(page);
      return { ok: false, error: membersError(err.code), code: err.code };
    }
    if (ownRole) revalidatePath("/", "layout");
    else revalidatePath(page);
    return { ok: true, message };
  });
}

/** Sets a member's role. `name` is only used in the sentence shown afterwards. */
export async function changeMemberRole(slug: string, userId: string, role: OrgRole, name: string): Promise<MembersActionResult> {
  if (!validTarget(slug, userId) || !MEMBER_ROLES.includes(role)) return invalid();
  const who = typeof name === "string" && name ? name : "The member";
  return run(slug, (s) => s.call((o) => identity().changeMemberRole(slug, userId, role, o)), `${who} is now ${role === "admin" ? "an" : "a"} ${role}.`);
}

/** Removes a member from the organization. */
export async function removeMember(slug: string, userId: string, name: string): Promise<MembersActionResult> {
  if (!validTarget(slug, userId)) return invalid();
  const who = typeof name === "string" && name ? name : "The member";
  return run(slug, (s) => s.call((o) => identity().removeMember(slug, userId, o)), `${who} was removed.`);
}

/** Makes another member the owner; the signed-in owner becomes an admin. */
export async function transferOwnership(slug: string, userId: string, name: string): Promise<MembersActionResult> {
  if (!validTarget(slug, userId)) return invalid();
  const who = typeof name === "string" && name ? name : "The member";
  return run(slug, (s) => s.call((o) => identity().transferOwnership(slug, userId, o)), `${who} is now an owner. You’re an admin.`, true);
}

/**
 * Sends invitations: each entry is an address with its own role. Used by the invite dialog on
 * the members and invitations pages (#345, #346).
 */
export async function inviteMembers(slug: string, entries: InviteEntry[]): Promise<MembersActionResult & { results?: InviteResult[] }> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return invalid();
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_INVITES) return invalid();
  const ok = (e: unknown): e is InviteEntry =>
    typeof e === "object" && e !== null && typeof (e as InviteEntry).email === "string" && isEmail((e as InviteEntry).email) && INVITE_ROLES.includes((e as InviteEntry).role);
  if (!entries.every(ok)) return invalid();
  const invites = entries.map(({ email, role }) => ({ email, role }));
  return withActionSession(async (session) => {
    try {
      const { results } = await session.call((o) => identity().createInvitations(slug, invites, o));
      revalidatePath(`/orgs/${slug}/settings`, "layout");
      const list = results ?? [];
      return { ok: true, message: inviteSummary(list), results: list };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: membersError(err.code), code: err.code };
    }
  });
}
