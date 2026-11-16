// Sidebar sections and the mobile bar's context (#998). Pure; safe in Client Components.
import { ORG_SETTINGS, PROJECT_SETTINGS, SECTIONS, VIEWS, type Section } from "./data";

export type View = (typeof VIEWS)[number];

/** The project's pages under their section headings (Monitor, Catalog, Configure), in nav order. */
export function navGroups(): { section: Section; views: View[] }[] {
  return SECTIONS.map((section) => ({ section, views: VIEWS.filter((v) => v.section === section) }));
}

/**
 * The page name the mobile bar shows (D7: the nav label): a project view's label, Project settings,
 * Organization settings in org scope, Account settings in account scope; empty when unknown.
 */
export function viewLabel(view: string, scope: { orgScope: boolean; account: boolean }): string {
  if (scope.account) return "Account settings";
  if (scope.orgScope) return ORG_SETTINGS.label;
  if (view === PROJECT_SETTINGS.slug) return PROJECT_SETTINGS.label;
  return VIEWS.find((v) => v.slug === view)?.label ?? "";
}
