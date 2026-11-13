// Inviting someone new from Access › Members (#809, #753 D4): an address that matches no
// organization member becomes an organization invitation that carries a role on this project and
// applies it on accept. Which typed addresses "Add people" offers to invite, the organization roles
// such an invitation may carry, the reason shown next to each refused address, and the sentences
// of the status line. Pure; safe in Client Components and Server Actions alike. Unit-tested in
// project-invite.test.ts.
import { listNames } from "./access-changes";
import type { Invitation, InviteResult, InviteRole, ProjectRole } from "./identity";
import { isEmail, splitInviteText } from "./invite-input";
import { invitationsError } from "./invitations";
import { ROLE_LABELS } from "./project-access";

/** The organization roles an invitation from a project carries, the default first (never admin: that is every project). */
export const PROJECT_INVITE_ORG_ROLES: readonly InviteRole[] = ["member", "viewer"];

/** What each organization role means for someone invited from a project. */
export const PROJECT_INVITE_ORG_ROLE_HELP: Record<"member" | "viewer", string> = {
  member: "Joins the organization as a Member and sees the projects its default access allows.",
  viewer: "Joins the organization as a Viewer: read-only wherever they have access.",
};

export const isProjectInviteOrgRole = (v: unknown): v is InviteRole => typeof v === "string" && (PROJECT_INVITE_ORG_ROLES as readonly string[]).includes(v);

/**
 * The addresses in the "Add people" search that match nobody `known` lists (the organization
 * members offered there): what "Invite to <org> and this project" would invite. Lower-cased, each
 * once, in the order typed. Empty when nothing typed is an address.
 */
export function inviteSuggestions(query: string, known: readonly { email: string }[]): string[] {
  const taken = new Set(known.map((k) => k.email.toLowerCase()));
  const out: string[] = [];
  for (const entry of splitInviteText(query)) {
    const email = entry.toLowerCase();
    if (isEmail(email) && !taken.has(email) && !out.includes(email)) out.push(email);
  }
  return out;
}

/** The reason shown next to an address the API did not invite; null when it was invited. */
export function inviteResultProblem(status: InviteResult["status"], orgName: string): string | null {
  switch (status) {
    case "already_member":
      return `already in ${orgName}, add them from the list`;
    case "duplicate":
      return "listed twice";
    default:
      return null;
  }
}

/** The status line after invitations went out: "Invited ada@example.com to Acme. They become a Viewer on Shop once they accept." */
export function projectInvitedMessage(emails: readonly string[], orgName: string, projectName: string, role: ProjectRole): string {
  const they = emails.length === 1 ? "They become" : "Each becomes";
  return `Invited ${listNames(emails)} to ${orgName}. ${they} ${role === "viewer" ? "a" : "an"} ${ROLE_LABELS[role]} on ${projectName} once they accept.`;
}

/** The sentence for an API error code of an invitation from a project; never a raw error. */
export function projectInviteError(code: string | undefined): string {
  switch (code) {
    case "forbidden":
      return "Only people who can invite to the organization and manage this project’s access can invite here.";
    case "reauth_required":
      return "Confirm it’s you to invite people.";
    case "not_found":
      return "This project no longer exists, or you can’t see it any more.";
    default:
      return invitationsError(code ?? "");
  }
}

/** The role `inv` gives on `project` (its slug), or null when it carries none there. */
export function grantOn(inv: Pick<Invitation, "project_grants">, project: string): ProjectRole | null {
  return inv.project_grants?.find((g) => g.project === project)?.role ?? null;
}
