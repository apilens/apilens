// Who may see which onboarding page (#326), decided from `GET /users/me/context`. Pure, so the
// branches can be unit tested; `lib/auth/onboarding.ts` applies it in Server Components.
import type { UserContext } from "./identity";
import { landingFor, onboardingPath } from "./landing";

export { ONBOARDING_SIGN_UP_PATH } from "./auth-gate";

/**
 * Step bar position (0 Account, 1 Organization, 2 Project, 3 Instrument, 4 Go live) of every
 * stored onboarding step. Steps on the same position are alternatives (join or create an
 * organization), so moving between them is never "ahead".
 */
const STAGES: Record<string, number> = {
  about: 0,
  join: 1,
  create: 1,
  project: 2,
  instrument: 3,
  install: 3,
  waiting: 4,
  requests: 4,
  invite: 4,
};

/** Step bar position of a stored step; unknown or missing steps count as the first one. */
export function stageOf(step: string | null | undefined): number {
  return step && Object.hasOwn(STAGES, step) ? STAGES[step] : 0;
}

/** The onboarding page is shown; `step` is its step bar position, `reached` the saved one. */
export interface OnboardingAllowed {
  kind: "show";
  step: number;
  reached: number;
}
export type OnboardingDecision = OnboardingAllowed | { kind: "redirect"; location: string };

/**
 * What to do with a signed-in request for `/onboarding/<page>`:
 * - onboarding finished → the user's project (as `/` would pick it);
 * - `page` is ahead of the saved step → the saved step's page;
 * - otherwise show it. Going back to an earlier step is always allowed.
 */
export function onboardingDecision(ctx: UserContext, page: string): OnboardingDecision {
  if (ctx.onboarding?.completed) {
    const landing = landingFor(ctx);
    // Finished but without a project or organization to open: let them through.
    if (!landing.startsWith("/onboarding/")) return { kind: "redirect", location: landing };
  }
  const saved = ctx.onboarding?.step;
  const reached = stageOf(saved);
  const step = stageOf(page);
  if (step > reached) {
    const location = onboardingPath(saved);
    if (location !== `/onboarding/${page}`) return { kind: "redirect", location };
  }
  return { kind: "show", step, reached };
}
