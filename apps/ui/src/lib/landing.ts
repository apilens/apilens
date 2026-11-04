// Where a signed-in user lands at `/` (#310), decided from `GET /users/me/context`. Pure, so the
// three branches (signed out is handled by the caller) can be unit tested.
import { ONBOARDING_PATH } from "./auth-gate";
import { HOME_VIEW, VIEWS } from "./data";
import type { UserContext } from "./identity";
import { findProject, orgHome } from "./scope";

/** Onboarding steps that have a page at `/onboarding/<step>`. */
const ONBOARDING_STEPS = new Set(["about", "join", "create", "project"]);

/** The onboarding page to resume on: the stored step when it has a page, else the first one. */
export function onboardingPath(step: string | null | undefined): string {
  return step && ONBOARDING_STEPS.has(step) ? `/onboarding/${step}` : ONBOARDING_PATH;
}

/**
 * The view a project opens on: the user's home preference when it names a view, else the
 * default. (Onboarding stores `endpoints | requests | exceptions`, which are not views yet.)
 */
export function homeView(ctx: UserContext): string {
  const home: string | undefined = ctx.user.preferences?.home;
  return home && VIEWS.some((v) => v.slug === home) ? home : HOME_VIEW;
}

/**
 * Landing page for a signed-in user: onboarding (at the stored step) without an organization;
 * otherwise the last project (or the first visible one) on the preferred home view.
 */
export function landingFor(ctx: UserContext): string {
  if (ctx.orgs.length === 0) return onboardingPath(ctx.onboarding?.step);

  const last = ctx.last_project_slug ? findProject(ctx, ctx.last_project_slug) : undefined;
  const project = last?.project ?? ctx.orgs.flatMap((o) => o.projects)[0];
  if (project) return `/${project.slug}/${homeView(ctx)}`;

  // Organizations but no project yet: finish onboarding, or open the organization.
  if (!ctx.onboarding?.completed) return onboardingPath(ctx.onboarding?.step);
  return orgHome(ctx.orgs[0], homeView(ctx));
}
