// The project's default access card on Access › Members (#808, #753 D2): the three choices in
// words, which change narrows access, and who loses or drops access when it does. The count of
// people who lose access always comes from the API's dry run; the names (up to five) and the
// people who drop to a lower role are worked out from the list the page already has. Pure; safe
// in Client and Server Components. Unit-tested in default-access.test.ts.

import type { AccessMember, DefaultAccess, OrgRole, ProjectRole } from "./identity";
import { highestRole, roleRank, ROLE_LABELS } from "./project-access";

/** The choices in the order the card lists them, widest first. */
export const DEFAULT_ACCESS_CHOICES: readonly DefaultAccess[] = ["org_role", "viewer", "none"];

/** The choice's title; the organization is named in the "view" one. */
export function choiceTitle(def: DefaultAccess, orgName: string): string {
  switch (def) {
    case "org_role":
      return "Follow organization role";
    case "viewer":
      return `Everyone in ${orgName} can view`;
    case "none":
      return "Restricted: only people added here and organization admins";
  }
}

/** One sentence under each choice: what org members without a direct grant get. */
export const CHOICE_HELP: Record<DefaultAccess, string> = {
  org_role: "Organization members can edit and organization viewers can view.",
  viewer: "Organization members and viewers can view, but not edit. People added here keep their role.",
  none: "Organization members and viewers can’t open the project unless they are added here. Owners and admins always can.",
};

/** The default in the status line after a change: "Default access is now restricted." */
export const SAVED_TEXT: Record<DefaultAccess, string> = {
  org_role: "Default access now follows the organization role.",
  viewer: "Everyone in the organization can now view this project.",
  none: "This project is now restricted.",
};

const WIDTH: Record<DefaultAccess, number> = { none: 0, viewer: 1, org_role: 2 };

/** Whether going from `from` to `to` can take access away from somebody (it needs a dry run and a confirmation). */
export function isNarrower(from: DefaultAccess, to: DefaultAccess): boolean {
  return WIDTH[to] < WIDTH[from];
}

/** The project role the default gives an org member with `orgRole`; null for none (owners and admins get Admin from their org role). */
export function defaultRoleFor(orgRole: OrgRole | undefined, def: DefaultAccess): ProjectRole | null {
  if (orgRole !== "member" && orgRole !== "viewer") return null;
  if (def === "org_role") return orgRole === "member" ? "editor" : "viewer";
  if (def === "viewer") return "viewer";
  return null;
}

/** Someone whose access shrinks: `role` is what they keep, null when they lose access. */
export interface Affected {
  member: AccessMember;
  role: ProjectRole | null;
}

/** Who loses access and who drops to a lower role when the default changes to `to`. */
export interface AccessImpact {
  lose: Affected[];
  drop: Affected[];
}

/**
 * Recomputes each person's role with the default source replaced by what `to` gives, as the API
 * derives it (highest grant wins, #753 D3). A person keeps their organization and direct sources.
 */
export function accessImpact(members: readonly AccessMember[], to: DefaultAccess): AccessImpact {
  const lose: Affected[] = [];
  const drop: Affected[] = [];
  for (const m of members) {
    const sources = m.sources ?? [];
    const orgRole = sources.find((s) => s.org_role)?.org_role;
    const kept = sources.filter((s) => s.kind !== "default").map((s) => s.role);
    const role = highestRole([...kept, defaultRoleFor(orgRole, to)]);
    if (role === null) lose.push({ member: m, role });
    else if (roleRank(role) < roleRank(m.effective_role)) drop.push({ member: m, role });
  }
  return { lose, drop };
}

/** How many names a list in the dialog shows before "and N more". */
export const MAX_NAMES = 5;

const nameOf = (m: Pick<AccessMember, "name" | "email">) => m.name || m.email;

/**
 * Up to five names, then "and N more" for the rest of `total` (the dry run's count may differ
 * from the names the page knows): "Max Member, Vera Viewer and 4 more".
 */
export function namesLine(people: readonly Pick<AccessMember, "name" | "email">[], total = people.length): string {
  const shown = people.slice(0, Math.min(MAX_NAMES, total)).map(nameOf);
  const rest = total - shown.length;
  if (shown.length === 0) return "";
  if (rest > 0) return `${shown.join(", ")} and ${rest.toLocaleString("en-US")} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const people = (n: number) => (n === 1 ? "1 person" : `${n.toLocaleString("en-US")} people`);

/** "3 people lose access to Shop" (the count is the dry run's). */
export function loseLine(count: number, projectName: string): string {
  return `${people(count)} ${count === 1 ? "loses" : "lose"} access to ${projectName}`;
}

/** "2 people drop to Viewer". */
export function dropLine(drop: readonly Affected[]): string {
  const roles = [...new Set(drop.map((d) => d.role).filter((r): r is ProjectRole => r !== null))];
  const to = roles.length === 1 ? ` to ${ROLE_LABELS[roles[0]]}` : " to a lower role";
  return `${people(drop.length)} ${drop.length === 1 ? "drops" : "drop"}${to}`;
}

/** The sentence for an API error code; never the raw error. */
export function defaultAccessError(code: string | undefined): string {
  switch (code) {
    case "forbidden":
      return "Only project admins can change the default access.";
    case "not_found":
      return "This project no longer exists, or you can’t see it any more.";
    case "invalid_request":
      return "That isn’t a default access APILens knows. Reload the page and try again.";
    case "authz_unavailable":
    case "unavailable":
      return "Access can’t be changed right now. Try again in a moment.";
    default:
      return "Couldn’t change the default access. Try again.";
  }
}

/** Whether `v` is one of the three defaults. */
export function isDefaultAccess(v: unknown): v is DefaultAccess {
  return v === "org_role" || v === "viewer" || v === "none";
}
