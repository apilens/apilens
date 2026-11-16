// Pure helpers for the Access › Members tab (#753 D1-D4): project role order, where a person's role
// comes from, and which people an admin can change. The server enforces every rule; these only
// shape what the UI offers. Safe in Client Components.

import type { AccessMember, AccessSource, DefaultAccess, OrgRole, ProjectRole } from "./identity";

/** Project roles, highest first: the order of role pickers and filters. */
export const PROJECT_ROLES: readonly ProjectRole[] = ["admin", "editor", "viewer"];

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

/** 1 viewer, 2 editor, 3 admin; 0 for anything else. */
export function roleRank(role: string | null | undefined): number {
  return role && Object.hasOwn(RANK, role) ? RANK[role as ProjectRole] : 0;
}

/** Sorts roles highest first (for `Array.prototype.sort`). */
export function compareRoles(a: ProjectRole, b: ProjectRole): number {
  return roleRank(b) - roleRank(a);
}

/** The highest of `roles`; null when there is none. */
export function highestRole(roles: readonly (ProjectRole | null | undefined)[]): ProjectRole | null {
  let best: ProjectRole | null = null;
  for (const r of roles) if (r && roleRank(r) > roleRank(best)) best = r;
  return best;
}

export const ROLE_LABELS: Record<ProjectRole, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

/** What each project role may do, one line for a role picker (#753 role matrix). */
export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  admin: "Manages access, the activity log and the danger zone.",
  editor: "Edits settings and environments, and manages API keys.",
  viewer: "Sees data, settings, members and key names.",
};

export const DEFAULT_ACCESS_LABELS: Record<DefaultAccess, string> = {
  org_role: "Organization role",
  viewer: "Everyone can view",
  none: "Restricted",
};

/** What each default access gives org members without a direct grant (#753 D2). */
export const DEFAULT_ACCESS_DESCRIPTIONS: Record<DefaultAccess, string> = {
  org_role: "Organization members can edit and organization viewers can view.",
  viewer: "Everyone in the organization can view.",
  none: "Only organization owners and admins, and people added directly.",
};

const ORG_ROLE_LABELS: Record<OrgRole, string> = { owner: "owner", admin: "admin", member: "member", viewer: "viewer" };

/** Where one source's role comes from, in words: "Organization owner", "Project default", "Added directly". */
export function sourceLabel(source: AccessSource): string {
  switch (source.kind) {
    case "org_role":
      return source.org_role ? `Organization ${ORG_ROLE_LABELS[source.org_role]}` : "Organization role";
    case "default":
      return "Project default";
    case "direct":
      return "Added directly";
  }
}

/** Display order when several sources grant the effective role: the organization, then a grant, then the default. */
const SOURCE_PRIORITY = { org_role: 0, direct: 1, default: 2 } as const;

/**
 * The source that gives the person their effective role (#753 D3). When several grant it, the
 * organization role wins, then a direct grant, then the project default.
 */
export function effectiveSource(member: Pick<AccessMember, "effective_role" | "sources">): AccessSource | null {
  const granting = (member.sources ?? []).filter((s) => s.role === member.effective_role);
  granting.sort((a, b) => SOURCE_PRIORITY[a.kind] - SOURCE_PRIORITY[b.kind]);
  return granting[0] ?? null;
}

/** Org owners and admins are Admin on every project (#753 D1): nothing on the project changes that. */
export function isOrgAdmin(member: Pick<AccessMember, "sources">): boolean {
  return (member.sources ?? []).some((s) => s.kind === "org_role" && s.role === "admin");
}

/** The role the person keeps once their direct grant is removed; null when they lose access. */
export function roleWithoutDirect(member: Pick<AccessMember, "sources">): ProjectRole | null {
  return highestRole((member.sources ?? []).filter((s) => s.kind !== "direct").map((s) => s.role));
}

/** What an admin may do to one person on the Members tab, with the reason when they may not. */
export interface MemberChange {
  /** Grant or change a direct role. */
  changeRole: boolean;
  /** Remove the direct grant. */
  remove: boolean;
  /** Why the role cannot be changed; absent when it can. */
  reason?: string;
}

/**
 * Who can be changed: nobody without `access.manage`; org owners and admins are always Admin, so
 * their role cannot be changed here; only a direct grant can be removed.
 */
export function memberChange(member: Pick<AccessMember, "sources" | "direct_role">, canManage: boolean): MemberChange {
  if (!canManage) return { changeRole: false, remove: false, reason: "Only project admins can change access." };
  if (isOrgAdmin(member)) {
    return { changeRole: false, remove: false, reason: "Organization owners and admins are Admin on every project." };
  }
  return { changeRole: true, remove: member.direct_role !== null };
}
