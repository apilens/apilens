// Where a signed-in user lands at `/` (#310), decided from `GET /users/me/context`. Pure, so the
// three branches (signed out is handled by the caller) can be unit tested.
import { ONBOARDING_PATH } from "./auth-gate";
import { HOME_VIEW, type ViewSlug } from "./data";
import type { ContextProject, HomeScreen, ManagedApp, UserContext } from "./identity";
import { parseHome } from "./onboarding-save";
import { projectSectionHref } from "./project-settings";
import { findProject, orgHome } from "./scope";

/** Onboarding steps that have a page at `/onboarding/<step>`. */
const ONBOARDING_STEPS = new Set(["about", "join", "create", "project"]);

/** The onboarding page to resume on: the stored step when it has a page, else the first one. */
export function onboardingPath(step: string | null | undefined): string {
  return step && ONBOARDING_STEPS.has(step) ? `/onboarding/${step}` : ONBOARDING_PATH;
}

/** The view each home screen (`preferences.home`, picked in onboarding or Account settings) opens (#994). */
export const HOME_SCREEN_VIEW: Readonly<Record<HomeScreen, ViewSlug>> = {
  endpoints: "traffic",
  requests: "explore",
  exceptions: "errors",
};

/** The home screens as Account settings offers them, in onboarding's order and words. */
export const HOME_SCREEN_CHOICES: readonly { id: HomeScreen; label: string; help: string }[] = [
  { id: "endpoints", label: "Slow or failing endpoints", help: "Every API, with its latency and error rate. Opens Traffic." },
  { id: "requests", label: "Requests across services", help: "One request, followed through every service. Opens Explore." },
  { id: "exceptions", label: "Exceptions", help: "Grouped, with the request that caused each one. Opens Errors." },
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

/**
 * Landing page for a signed-in user: onboarding (at the stored step) without an organization;
 * otherwise the last project (or the first visible one) on the preferred home view, or on
 * Settings > SDK setup when `hasData` is false (that project has no ingested data yet).
 * `hasData` undefined (not checked, or the check failed) opens the home view.
 */
export function landingFor(ctx: UserContext, hasData?: boolean): string {
  if (ctx.orgs.length === 0) return onboardingPath(ctx.onboarding?.step);

  const project = landingProject(ctx);
  if (project) return hasData === false ? sdkSetupPath(project.slug) : `/${project.slug}/${homeView(ctx)}`;

  // Organizations but no project yet: finish onboarding, or open the organization.
  if (!ctx.onboarding?.completed) return onboardingPath(ctx.onboarding?.step);
  return orgHome(ctx.orgs[0], homeView(ctx));
}
