// The project Access page (`/project/<project>/access/*`, #801): its tabs, in order, and who sees each.
// Members is the default tab (`/access`), API keys answer at `/access/keys` and Activity at
// `/access/activity` for those allowed to read the activity log. Pure; safe in Client Components.

import { type Action, type Capabilities, can } from "./capabilities";
import { projectHref } from "./routes";

/** The page's title (its nav label) and one-line description (#1051). */
export const ACCESS = { label: "Access", lead: "Who can see and change this project, and its API keys." } as const;

export interface AccessTab {
  /** URL segment under `/project/<project>/access`; empty for Members, which `/access` itself opens. */
  slug: string;
  label: string;
  /** The action that makes the tab visible; absent means everyone who sees the project. */
  capability?: Action;
}

export const ACCESS_TABS: readonly AccessTab[] = [
  { slug: "", label: "Members" },
  { slug: "keys", label: "API keys" },
  { slug: "activity", label: "Activity", capability: "audit.read" },
];

/** `/project/<project>/access` or `/project/<project>/access/<slug>`. */
export function accessHref(project: string, tab: Pick<AccessTab, "slug">): string {
  return tab.slug ? projectHref(project, "access", tab.slug) : projectHref(project, "access");
}

/** The tabs the user may see on `project`, in order. */
export function visibleAccessTabs(capabilities: Capabilities | null | undefined, project: string): AccessTab[] {
  return ACCESS_TABS.filter((t) => !t.capability || can(capabilities, project, t.capability));
}

/**
 * The tab a `/project/<project>/access/[[...tab]]` route points at among `visible`; undefined means 404
 * (an unknown tab, a deeper path, or a tab the user may not see).
 */
export function accessTab(tab: string[] | undefined, visible: readonly AccessTab[] = ACCESS_TABS): AccessTab | undefined {
  if (!tab || tab.length === 0) return visible.find((t) => t.slug === "");
  if (tab.length > 1 || tab[0] === "") return undefined;
  return visible.find((t) => t.slug === tab[0]);
}

/** The page title: `Access · <project>`. */
export function accessTitle(projectName: string): string {
  return `Access · ${projectName}`;
}

/**
 * Where the old `/project/<project>/settings/keys` sends a reader: `keysPath` with the same query (the
 * page they were on, its size), so a bookmark keeps its place.
 */
export function movedKeysHref(keysPath: string, search: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  const s = q.toString();
  return s ? `${keysPath}?${s}` : keysPath;
}
