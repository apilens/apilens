// Where a signed-in user lands at `/` (#310), decided from `GET /users/me/context`. Pure, so the
// three branches (signed out is handled by the caller) can be unit tested.
import { HOME_VIEW, type ViewSlug } from "./data";
import type { ContextOrg, ContextProject, HomeScreen, ManagedApp, UserContext } from "./identity";
import { parseHome } from "./onboarding-save";
import { projectSectionHref } from "./project-settings";
import { orgHref, projectHref } from "./routes";
import { findProject, orgHome } from "./scope";

/** The one onboarding page. */
export function onboardingPath(): "/onboarding/welcome" {
  return "/onboarding/welcome";
}

/** Where Welcome lands after joining `org`: its first project, or the organization when it has none. */
export function landingAfterJoin(org: ContextOrg): string {
  return orgHome(org, HOME_VIEW);
}

/** The view each home screen (`preferences.home`, picked in Account settings) opens (#994). */
export const HOME_SCREEN_VIEW: Readonly<Record<HomeScreen, ViewSlug>> = {
  endpoints: "traffic",
  requests: "explore",
  // Errors is "Coming soon": until it ships, Exceptions opens Traffic.
  exceptions: "traffic",
};

/** The home screens Account settings offers. */
export const HOME_SCREEN_CHOICES: readonly { id: HomeScreen; label: string; help: string }[] = [
  { id: "endpoints", label: "Slow or failing endpoints", help: "Every API, with its latency and error rate. Opens Traffic." },
  { id: "requests", label: "Requests across services", help: "One request, followed through every service. Opens Explore." },
];

/** The view a project opens on: the one the user's home screen maps to, else the default. */
export function homeView(ctx: UserContext): string {
  const home = parseHome(ctx.user.preferences?.home);
  return home ? HOME_SCREEN_VIEW[home] : HOME_VIEW;
}

/** Where a project without any ingested data opens: Settings > SDK setup (#994). */
export function sdkSetupPath(project: string): string {
  return projectSectionHref(project, { slug: "sdk" });
}

/** Whether any of the project's apps ever received data (an SDK reported for it). */
export function projectHasData(apps: readonly Pick<ManagedApp, "first_seen_at" | "last_seen_at">[] | null | undefined): boolean {
  return (apps ?? []).some((a) => Boolean(a.first_seen_at || a.last_seen_at));
}

/** The project `/` opens: the last one when still visible, else the first visible one. */
export function landingProject(ctx: UserContext): ContextProject | undefined {
  const last = ctx.last_project_slug ? findProject(ctx, ctx.last_project_slug) : undefined;
  return last?.project ?? ctx.orgs.flatMap((o) => o.projects)[0];
}

/** The organization `/org` opens: the last project's when still visible, else the first one. */
export function lastOrg(ctx: UserContext): ContextOrg | undefined {
  const last = ctx.last_project_slug ? findProject(ctx, ctx.last_project_slug) : undefined;
  return last?.org ?? ctx.orgs[0];
}

/** Where `/org` goes (Supabase's): the last organization's projects; onboarding without one. */
export function orgLanding(ctx: UserContext): string {
  const org = lastOrg(ctx);
  return org ? orgHref(org.slug) : onboardingPath();
}

/**
 * Landing page for a signed-in user: onboarding without an organization;
 * otherwise the last project (or the first visible one) on the preferred home view, or on
 * Settings > SDK setup when `hasData` is false (that project has no ingested data yet).
 * `hasData` undefined (not checked, or the check failed) opens the home view.
 */
export function landingFor(ctx: UserContext, hasData?: boolean): string {
  if (ctx.orgs.length === 0) return onboardingPath();

  const project = landingProject(ctx);
  if (project) return hasData === false ? sdkSetupPath(project.slug) : projectHref(project.slug, homeView(ctx));

  // Organizations but no project yet: finish onboarding, or open the organization's projects.
  if (!ctx.onboarding?.completed) return onboardingPath();
  return orgHref(ctx.orgs[0].slug);
}
