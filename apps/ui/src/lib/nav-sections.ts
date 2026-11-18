// Sidebar sections and the mobile bar's context (#998). Pure; safe in Client Components.
import { PROJECT_SETTINGS, SECTIONS, VIEWS, type Section } from "./data";

export type View = (typeof VIEWS)[number];

/** The project's pages under their section headings (Monitor, Catalog, Configure), in nav order. */
export function navGroups(): { section: Section; views: View[] }[] {
  return SECTIONS.map((section) => ({ section, views: VIEWS.filter((v) => v.section === section) }));
}

/**
 * The page name the mobile bar shows (D7: the nav label): a project view's label, Project settings,
 * Account settings in account scope; empty in organization scope (Supabase's: the org crumb is the
 * last one) and when unknown.
 */
export function viewLabel(view: string, scope: { orgScope: boolean; account: boolean }): string {
  if (scope.account) return "Account settings";
  if (scope.orgScope) return "";
  if (view === PROJECT_SETTINGS.slug) return PROJECT_SETTINGS.label;
  return VIEWS.find((v) => v.slug === view)?.label ?? "";
}
