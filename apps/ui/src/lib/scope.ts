// The app shell's tenancy, read from `GET /users/me/context` (#286): which organization and
// project a URL points at, and how the shell labels them. Pure; safe in Client Components.
import type { ContextOrg, ContextProject, OrgRole, User, UserContext } from "./identity";

export type { ContextOrg, ContextProject, UserContext };

/** The organization and project a `/<project>/...` URL points at, when the user can see it. */
export function findProject(ctx: UserContext, slug: string): { org: ContextOrg; project: ContextProject } | undefined {
  for (const org of ctx.orgs) {
    const project = org.projects.find((p) => p.slug === slug);
    if (project) return { org, project };
  }
  return undefined;
}

/** The organization an `/orgs/<org>/...` URL points at, when the user is a member. */
export function findOrg(ctx: UserContext, slug: string): ContextOrg | undefined {
  return ctx.orgs.find((o) => o.slug === slug);
}

/** Where switching to an organization lands: its first project, or its settings when it has none. */
export function orgHome(org: ContextOrg, view: string): string {
  const first = org.projects[0];
  return first ? `/${first.slug}/${view}` : `/orgs/${org.slug}/settings`;
}

/** The organization's single-letter mark. */
export function orgMark(org: Pick<ContextOrg, "name" | "slug">): string {
  return (org.name.trim()[0] ?? org.slug[0] ?? "?").toUpperCase();
}

/** `owner` → `Owner`. */
export function roleLabel(role: OrgRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** `1 project`, `3 projects`. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** How the account menu shows the signed-in user: the name, or the email's local part. */
export function userLabel(user: Pick<User, "name" | "email">): { name: string; initials: string; email: string } {
  const name = user.name?.trim() || user.email.split("@")[0] || user.email;
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2)).toUpperCase();
  return { name, initials, email: user.email };
}
