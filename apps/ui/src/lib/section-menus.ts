// The sections with a secondary sidebar (#1051) and what each one's menu lists: Project settings,
// Access, Incidents, Organization settings and Account settings. Each section's `layout.tsx`
// passes one of these to a SectionMenu (components/shell/section-menu.tsx). Pages without
// sub-pages (Traffic, Errors, Explore…) get none. Pure; safe in Client Components.

import { ACCESS_TABS, accessHref } from "./access";
import { ACCOUNT_SECTIONS, ACCOUNT_SETTINGS, accountSectionHref } from "./account-settings";
import { badgeText, incidentsHref, rulesHref } from "./alerts";
import { type Capabilities, can } from "./capabilities";
import { ORG_SETTINGS, PROJECT_SETTINGS } from "./data";
import type { OrgRole } from "./identity";
import { ORG_SETTINGS_SECTIONS, orgSettingsHref } from "./org-settings";
import { PROJECT_SECTIONS, PROJECT_SETTINGS_GROUPS, projectSectionHref } from "./project-settings";

/** One link of a section menu; see SectionMenu for what each field does. */
export interface SectionMenuItem {
  label: string;
  href: string;
  active?: boolean;
  badge?: string | number;
  hidden?: boolean;
  tone?: "danger";
}

/** A titled (or untitled) run of items; groups are split by a hairline. */
export interface SectionMenuGroup {
  title?: string;
  items: SectionMenuItem[];
}

/** A section menu: its title (the section's nav label) and its groups, in order. */
export interface SectionMenuSpec {
  title: string;
  groups: SectionMenuGroup[];
}

/** Whether `path` is `href` or below it, segment-wise (any query on `href` is ignored). */
function under(path: string, href: string): boolean {
  const base = href.split("?")[0].replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The `href` of the item that is on for `path` (a pathname, no query): the longest `href` that
 * `path` is at or under, so `/settings/privacy` beats `/settings`. Null when none is.
 */
export function activeHref(path: string, items: readonly Pick<SectionMenuItem, "href">[]): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    if (under(path, href) && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

/**
 * Project settings (`/project/<project>/settings/*`), grouped as `lib/project-settings.ts` groups
 * them. A section the user may not open is hidden, and so is one with no content yet (`built`
 * lists the slugs that have some): the menu never offers "Nothing here yet".
 */
export function projectSettingsMenu(project: string, capabilities: Capabilities | null | undefined, built: ReadonlySet<string>): SectionMenuSpec {
  return {
    title: PROJECT_SETTINGS.label,
    groups: PROJECT_SETTINGS_GROUPS.map((group) => ({
      title: group,
      items: PROJECT_SECTIONS.filter((s) => s.group === group).map((s) => ({
        label: s.label,
        href: projectSectionHref(project, s),
        hidden: !built.has(s.slug) || (s.capability !== undefined && !can(capabilities, project, s.capability)),
        tone: s.danger ? ("danger" as const) : undefined,
      })),
    })),
  };
}

/** Access (`/project/<project>/access/*`): Members, API keys, and Activity with `audit.read`. */
export function accessMenu(project: string, capabilities: Capabilities | null | undefined): SectionMenuSpec {
  return {
    title: "Access",
    groups: [
      {
        items: ACCESS_TABS.map((t) => ({
          label: t.label,
          href: accessHref(project, t),
          hidden: t.capability !== undefined && !can(capabilities, project, t.capability),
        })),
      },
    ],
  };
}

/** Incidents (`/project/<project>/incidents`, `/incidents/rules`); Incidents' badge is the open count. */
export function incidentsMenu(project: string, open: number): SectionMenuSpec {
  return {
    title: "Incidents",
    groups: [
      {
        items: [
          { label: "Incidents", href: incidentsHref(project), badge: badgeText(open) },
          { label: "Alert rules", href: rulesHref(project) },
        ],
      },
    ],
  };
}

/** Organization settings (`/org/<org>/general|sso|audit`); Audit log only for owners and admins. */
export function orgSettingsMenu(org: string, role: OrgRole): SectionMenuSpec {
  return {
    title: ORG_SETTINGS.label,
    groups: [
      {
        items: ORG_SETTINGS_SECTIONS.map((s) => ({
          label: s.label,
          href: orgSettingsHref(org, s),
          hidden: s.visible !== undefined && !s.visible(role),
        })),
      },
    ],
  };
}

/** Account settings (`/settings/*`). */
export function accountMenu(): SectionMenuSpec {
  return {
    title: ACCOUNT_SETTINGS.label,
    groups: [
      {
        items: ACCOUNT_SECTIONS.map((s) => ({
          label: s.label,
          href: accountSectionHref(s),
          tone: s.slug === "danger" ? ("danger" as const) : undefined,
        })),
      },
    ],
  };
}
