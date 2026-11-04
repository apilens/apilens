// "Join your team" (#329): the organizations the signed-in user may join through their verified
// email domain (`GET /users/me/joinable-orgs`, #283), what joining one does to onboarding and the
// sentences the screen shows. Pure, so the branches can be unit tested; the join page and its
// Server Action apply them.
import type { Org, UpdateOnboardingRequest, UserContext } from "./identity";
import { homeView } from "./landing";
import { orgHome } from "./scope";

/** Where the join screen sends users who have nothing to join, and its "Create a separate organization". */
export const CREATE_ORG_PATH = "/onboarding/create";
/** The onboarding step after joining an organization that has no project yet. */
export const PROJECT_STEP = "project";
/** The project step's page (#331). */
export const PROJECT_STEP_PATH = `/onboarding/${PROJECT_STEP}`;

/** The domain of `email` (lower-case, without "@"), or "" when it has none. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
}

export interface JoinDeps {
  join: () => Promise<Org>;
  context: () => Promise<UserContext>;
  updateOnboarding: (patch: UpdateOnboardingRequest) => Promise<unknown>;
}

/**
 * Joins the organization and says where the browser goes next. The organization is saved as the
 * onboarding answer (`org_slug`). When it already has a project, onboarding is finished and the
 * user opens its first project on their home view; otherwise they continue to the project step
 * to create one. Identity errors (`forbidden` when it is no longer joinable, …) propagate.
 */
export async function joinOrganization(deps: JoinDeps): Promise<string> {
  const org = await deps.join();
  const ctx = await deps.context();
  const joined = ctx.orgs.find((o) => o.slug === org.slug);
  const answers = { org_slug: org.slug };
  if (joined && joined.projects.length > 0) {
    await deps.updateOnboarding({ completed: true, answers });
    return orgHome(joined, homeView(ctx));
  }
  await deps.updateOnboarding({ step: PROJECT_STEP, answers });
  return PROJECT_STEP_PATH;
}

/** The sentence the join screen shows when joining `orgName` failed with API error `code`. */
export function joinError(code: string, orgName: string): string {
  switch (code) {
    case "forbidden":
    case "not_found":
      return `You can no longer join ${orgName}. Its owners may have turned off joining by email domain.`;
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
