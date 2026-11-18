// The app's URL scheme, Supabase Studio's: organization pages under `/org/<org>`, project pages
// under `/project/<project>/...`. The project URL carries no organization: a project's slug is
// unique among active projects (the `projects_slug_active` index), the job Supabase's `ref` does,
// and a renamed project's old slug still redirects (lib/project-redirect.ts). Every project and
// organization link in the app is built here. Pure; safe in Client Components and the proxy.

/** Where every project page lives: `/project/<project>/<view>`. */
export const PROJECT_ROOT = "/project";
/** Where every organization page lives: `/org/<org>`; `/org` alone opens the last one. */
export const ORG_ROOT = "/org";
/** Every organization the user belongs to. */
export const ORGANIZATIONS_PATH = "/organizations";

const seg = (s: string) => encodeURIComponent(s);

/**
 * `/project/<slug>`, `/project/<slug>/<view>` or `/project/<slug>/<view>/<sub>`. `sub` is appended
 * as given (it may hold several segments, already encoded); a leading `/` on it is dropped.
 */
export function projectHref(slug: string, view?: string, sub?: string): string {
  let href = `${PROJECT_ROOT}/${seg(slug)}`;
  if (view) href += `/${view}`;
  if (view && sub) href += `/${sub.replace(/^\/+/, "")}`;
  return href;
}

/** The organization pages: the Projects list (no section), Team, and the settings sections. */
export type OrgSection = "" | "team" | "general" | "sso" | "audit";

/** `/org/<slug>` (its projects) or `/org/<slug>/<section>`. */
export function orgHref(slug: string, section: OrgSection = ""): string {
  return section ? `${ORG_ROOT}/${seg(slug)}/${section}` : `${ORG_ROOT}/${seg(slug)}`;
}

/** The organization pages that are Organization settings (its rail item is on for each). */
export const ORG_SETTINGS_ROUTES: readonly OrgSection[] = ["general", "sso", "audit"];

/** The org rail's items. */
export type OrgNavItem = "projects" | "team" | "settings";

/** The rail in organization scope (Supabase's `OrganizationLinks`), only the pages that exist. */
export const ORG_NAV: readonly { item: OrgNavItem; label: string; section: OrgSection }[] = [
  { item: "projects", label: "Projects", section: "" },
  { item: "team", label: "Team", section: "team" },
  { item: "settings", label: "Organization settings", section: "general" },
];

/** Which org rail item is on for an organization page (`section` as in {@link orgHref}). */
export function orgNavActive(section: string): OrgNavItem | null {
  if (section === "" || section === "projects") return "projects";
  if (section === "team") return "team";
  if ((ORG_SETTINGS_ROUTES as readonly string[]).includes(section)) return "settings";
  return null;
}

/**
 * Top-level path segments that are pages of their own, never a project slug from the old
 * `/<project>/...` scheme. Next's internals and files (anything with a dot) never reach here.
 */
export const TOP_LEVEL_ROUTES: ReadonlySet<string> = new Set([
  "org",
  "orgs",
  "organizations",
  "project",
  "settings",
  "design",
  "api",
  "auth",
  "invite",
  "onboarding",
  "sign-in",
  "sign-up",
  "verify",
  "_next",
]);

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The old organization settings sections and the page each one moved to. */
const OLD_ORG_SECTIONS: Readonly<Record<string, OrgSection>> = {
  "": "general",
  members: "team",
  invitations: "team",
  sso: "sso",
  audit: "audit",
};

/**
 * Where an old URL moved (permanently), the query string kept: `/<project>/...` →
 * `/project/<project>/...`, `/orgs/<org>/settings[/<section>]` → the org page that section is now
 * part of, `/orgs/<org>` → `/org/<org>`. Null for anything else (it is a current URL, or not ours).
 * `search` is the raw query string with its `?`, or "".
 */
export function legacyRedirect(pathname: string, search: string): string | null {
  const parts = pathname.split("/");
  // parts[0] is "" for any path starting with "/".
  if (parts[0] !== "" || parts.length < 2) return null;
  const first = parts[1];
  if (!first) return null;

  if (first === "orgs") {
    const org = parts[2];
    if (!org || !SLUG.test(org)) return null;
    if (parts.length === 3 || (parts.length === 4 && parts[3] === "")) return orgHref(org) + search;
    if (parts[3] !== "settings") return null;
    const section = OLD_ORG_SECTIONS[parts[4] ?? ""] ?? "general";
    return orgHref(org, section) + search;
  }

  if (TOP_LEVEL_ROUTES.has(first) || !SLUG.test(first)) return null;
  const rest = parts.slice(2).join("/");
  return `${projectHref(first)}${rest ? `/${rest}` : ""}${search}`;
}
