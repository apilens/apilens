"use server";

// Server Action of the 'Invite your team' step (#336): sends the invitations
// (`POST /orgs/{slug}/invitations`, one role per address) and adds the number emailed to the
// saved `invited` answer. The input is checked first (a Server Action is a public POST endpoint);
// failures answer a sentence to show, never a raw error. Skip and "Open project" finish
// onboarding through the first-data step's `openProject`.
import { type InviteEntry, type InviteResult, identity, isApiError } from "@/lib/identity";
import { INVITE_ROLES, MAX_INVITES, isEmail } from "@/lib/invite-input";
import { inviteError, sentCount } from "@/lib/onboarding-invite";
import { savedAnswers } from "@/lib/onboarding-save";
import { withActionSession } from "@/lib/server-session";

export type InviteTeamResult = { ok: true; results: InviteResult[] } | { ok: false; error: string; code: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The API's cap on the saved `invited` answer (account.MaxInvited). */
const MAX_INVITED = 1000;

const isEntry = (e: unknown): e is InviteEntry =>
  typeof e === "object" &&
  e !== null &&
  typeof (e as InviteEntry).email === "string" &&
  isEmail((e as InviteEntry).email) &&
  INVITE_ROLES.includes((e as InviteEntry).role);

/** "Send N invitations": invites each address of `entries` to the organization `org` with its role. */
export async function inviteTeam(org: string, entries: InviteEntry[]): Promise<InviteTeamResult> {
  const invalid = { ok: false as const, error: inviteError("invalid_request"), code: "invalid_request" };
  if (typeof org !== "string" || !SLUG.test(org)) return invalid;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_INVITES || !entries.every(isEntry)) return invalid;
  const invites = entries.map(({ email, role }) => ({ email: email.toLowerCase(), role }));
  return withActionSession(async (session) => {
    let results: InviteResult[];
    try {
      results = (await session.call((o) => identity().createInvitations(org, invites, o))).results ?? [];
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false as const, error: inviteError(err.code), code: err.code };
    }
    // The count is a nicety for later screens: the invitations went out even if saving it fails.
    const sent = sentCount(results);
    if (sent > 0) {
      try {
        const ctx = await session.call((o) => identity().context(o));
        const invited = Math.min(MAX_INVITED, (savedAnswers(ctx).invited ?? 0) + sent);
        await session.call((o) => identity().updateOnboarding({ answers: { invited } }, o));
      } catch (err) {
        if (!isApiError(err)) throw err;
      }
    }
    return { ok: true as const, results };
  });
}
