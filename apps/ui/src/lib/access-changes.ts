// Changing who has access to a project (#807, #753 D1-D4): who "Add people" offers, what a
// change or removal leaves the person with (said before confirming), the sentences the status line
// shows, and the input checks the Server Actions repeat. Pure; safe in Client and Server
// Components alike. Unit-tested in access-changes.test.ts.

import type { AccessMember, AccessSource, Member, ProjectRole } from "./identity";
import { PROJECT_ROLES, ROLE_LABELS, highestRole } from "./project-access";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most people one "Add people" save grants at once. */
export const MAX_ADD = 50;

export const isProjectSlug = (v: unknown): v is string => typeof v === "string" && SLUG.test(v);
export const isUserId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isProjectRole = (v: unknown): v is ProjectRole => typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v);

/** "an Admin", "an Editor", "a Viewer". */
export const withArticle = (role: ProjectRole) => `${role === "viewer" ? "a" : "an"} ${ROLE_LABELS[role]}`;

/** A person as the dialogs name them. */
export const personName = (p: { name?: string; email: string }) => p.name || p.email;

/** One org member "Add people" can offer. */
export interface Candidate {
  user_id: string;
  name: string;
  email: string;
  initials: string;
}

/**
 * The organization members "Add people" offers: everyone without a direct role on the project,
 * except org owners and admins (they are Admin on every project, D1). Sorted by name.
 */
export function addCandidates(orgMembers: readonly Member[], access: readonly Pick<AccessMember, "user_id" | "direct_role">[]): Candidate[] {
  const granted = new Set(access.filter((m) => m.direct_role).map((m) => m.user_id));
  return orgMembers
    .filter((m) => m.role !== "owner" && m.role !== "admin" && !granted.has(m.user.id))
    .map((m) => ({
      user_id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      initials: (m.user.name || m.user.email).split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join("").slice(0, 2),
    }))
    .sort((a, b) => personName(a).localeCompare(personName(b)));
}

/** "through the organization" or "through the project default": where a kept role comes from. */
function through(sources: readonly AccessSource[], role: ProjectRole): string {
  return sources.some((s) => s.kind === "org_role" && s.role === role) ? "through the organization" : "through the project default";
}

/** The highest role the person has without their direct grant, and where it comes from. */
function kept(member: Pick<AccessMember, "sources">): { role: ProjectRole; via: string } | null {
  const others = (member.sources ?? []).filter((s) => s.kind !== "direct");
  const role = highestRole(others.map((s) => s.role));
  return role ? { role, via: through(others, role) } : null;
}

/**
 * What removing the person's direct role leaves them with, said before confirming:
 * "Lena stays an Editor through the project default." or "Lena loses access to Shop."
 */
export function removeConsequence(member: Pick<AccessMember, "name" | "email" | "sources">, projectName: string): string {
  const name = personName(member);
  const k = kept(member);
  return k ? `${name} stays ${withArticle(k.role)} ${k.via}.` : `${name} loses access to ${projectName}.`;
}

/**
 * What giving the person `role` directly changes, when it is not simply that role: their
 * organization or the project default already gives them a higher one. Null otherwise.
 */
export function changeConsequence(member: Pick<AccessMember, "name" | "email" | "sources">, role: ProjectRole): string | null {
  const k = kept(member);
  if (!k || highestRole([k.role, role]) === role) return null;
  return `${personName(member)} stays ${withArticle(k.role)} ${k.via}.`;
}

/** "Max", "Max and Vera", "Max, Vera and Sam". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The status line after adding people: "Added Max Member and Vera Viewer as Editors." */
export function addedMessage(names: readonly string[], role: ProjectRole, projectName: string): string {
  const label = names.length === 1 ? ROLE_LABELS[role] : `${ROLE_LABELS[role]}s`;
  return `Added ${listNames(names)} to ${projectName} as ${label}.`;
}

/** The status line after a role change: "Tom Becker is now an Admin on Shop." */
export function changedMessage(name: string, role: ProjectRole, projectName: string): string {
  return `${name} is now ${withArticle(role)} on ${projectName}.`;
}

/** The status line after a removal, with what the person keeps. */
export function removedMessage(member: Pick<AccessMember, "name" | "email" | "sources">, projectName: string): string {
  return `Removed ${personName(member)} from ${projectName}. ${removeConsequence(member, projectName)}`;
}

/** The sentence for an API error code; never a raw error. */
export function accessChangeError(code: string | undefined): string {
  switch (code) {
    case "forbidden":
      return "Only project admins can change access.";
    case "not_org_member":
      return "That person is no longer in the organization. Reload the page to see who is.";
    case "not_found":
      return "This project no longer exists, or you can’t see it any more.";
    case "invalid_request":
      return "That change wasn’t accepted. Reload the page and try again.";
    case "reauth_required":
      return "Confirm it’s you to change access.";
    default:
      return "Couldn’t change access right now. Try again.";
  }
}
