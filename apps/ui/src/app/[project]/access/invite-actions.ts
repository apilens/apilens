"use server";

// Server Actions of inviting someone new from Access › Members (#809, #753 D4): an organization
// invitation that carries a role on this project, and resending or revoking the project's pending
// invitations. Each re-checks its input (a Server Action is a public POST endpoint): the project
// and organization slugs, every address, the organization role (member or viewer) and the project
// role. The API decides who may (`organization#invite` plus `manage_access` on the project).
// Results are sentences, never a raw error; refused addresses come back by address so the dialog
// shows each reason next to its address.
import { revalidatePath } from "next/cache";
import { isProjectRole, isProjectSlug } from "@/lib/access-changes";
import { type InviteEntry, type ProjectRole, identity, isApiError } from "@/lib/identity";
import { MAX_INVITES, isEmail } from "@/lib/invite-input";
import { invitationsError } from "@/lib/invitations";
import { inviteResultProblem, isProjectInviteOrgRole, projectInviteError, projectInvitedMessage } from "@/lib/project-invite";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type ProjectInviteResult =
  | {
      ok: true;
      message: string;
      /** Addresses the API did not invite, with the reason shown next to each. */
      problems?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      problems?: Record<string, string>;
      /** Seconds until a resend is allowed (`rate_limited`). */
      retryAfter?: number;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): ProjectInviteResult => ({ ok: false, error: projectInviteError("invalid_request"), code: "invalid_request" });
const label = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : fallback);
const page = (project: string) => `/${project}/access`;

/** Names for the sentences: the organization and the project. */
export interface InviteNames {
  org: string;
  project: string;
}

/**
 * Invites each address to organization `org` with its own organization role (member or viewer);
 * every invitation carries `role` on `project`. Addresses the API refused (already a member,
 * listed twice) come back in `problems`; when none went out the result is not ok.
 */
export async function inviteToProject(project: string, org: string, entries: InviteEntry[], role: ProjectRole, names: InviteNames): Promise<ProjectInviteResult> {
  if (!isProjectSlug(project) || !isProjectSlug(org) || !isProjectRole(role)) return invalid();
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_INVITES) return invalid();
  const ok = (e: unknown): e is InviteEntry => typeof e === "object" && e !== null && typeof (e as InviteEntry).email === "string" && isEmail((e as InviteEntry).email) && isProjectInviteOrgRole((e as InviteEntry).role);
  if (!entries.every(ok)) return invalid();
  const invites = entries.map(({ email, role: r }) => ({ email: email.toLowerCase(), role: r }));
  if (new Set(invites.map((i) => i.email)).size !== invites.length) return invalid();
  const orgName = label(names?.org, "the organization");
  const projectName = label(names?.project, "the project");
  return withActionSession(async (session) => {
    let results;
    try {
      ({ results } = await session.call((o) => identity().createInvitations(org, invites, o, [{ project, role }])));
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: projectInviteError(err.code), code: err.code };
    }
    const sent: string[] = [];
    const problems: Record<string, string> = {};
    for (const r of results ?? []) {
      const problem = inviteResultProblem(r.status, orgName);
      if (problem) problems[r.email.toLowerCase()] = problem;
      else sent.push(r.email.toLowerCase());
    }
    const refused = Object.keys(problems).length > 0;
    if (sent.length === 0) {
      return { ok: false, error: refused ? "Nobody was invited. Each address says why." : projectInviteError(undefined), problems: refused ? problems : undefined };
    }
    revalidatePath(page(project));
    return { ok: true, message: projectInvitedMessage(sent, orgName, projectName, role), ...(refused ? { problems } : {}) };
  });
}

/** Runs one call on an invitation of `org`, then revalidates the project's Access page. */
async function run(project: string, call: (session: ServerSession) => Promise<unknown>, message: string): Promise<ProjectInviteResult> {
  return withActionSession(async (session) => {
    try {
      await call(session);
    } catch (err) {
      if (!isApiError(err)) throw err;
      // Accepted or revoked meanwhile: show the fresh list along with the sentence.
      if (err.code === "invite_expired") revalidatePath(page(project));
      return { ok: false, error: invitationsError(err.code), code: err.code, retryAfter: err.retryAfter ?? undefined };
    }
    revalidatePath(page(project));
    return { ok: true, message };
  });
}

const validIds = (project: unknown, org: unknown, id: unknown) => isProjectSlug(project) && isProjectSlug(org) && typeof id === "string" && UUID.test(id);

/** Emails a pending invitation again with a new link. `email` only words the sentence. */
export async function resendProjectInvitation(project: string, org: string, id: string, email: string): Promise<ProjectInviteResult> {
  if (!validIds(project, org, id)) return invalid();
  return run(project, (s) => s.call((o) => identity().resendInvitation(org, id, o)), `Invitation resent to ${label(email, "the invitee")}.`);
}

/** Revokes a pending invitation: its link stops working and its project role is dropped. */
export async function revokeProjectInvitation(project: string, org: string, id: string, email: string): Promise<ProjectInviteResult> {
  if (!validIds(project, org, id)) return invalid();
  return run(project, (s) => s.call((o) => identity().revokeInvitation(org, id, o)), `Invitation to ${label(email, "the invitee")} revoked.`);
}
