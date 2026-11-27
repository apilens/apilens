// Who may see the onboarding page (#326), decided from `GET /users/me/context`. Pure, so the
// branches can be unit tested; `lib/auth/onboarding.ts` applies it in Server Components.
import type { UserContext } from "./identity";
import { landingFor } from "./landing";

export { ONBOARDING_SIGN_UP_PATH } from "./auth-gate";

export type OnboardingDecision = { kind: "show" } | { kind: "redirect"; location: string };

/**
 * What to do with a signed-in request for `/onboarding/welcome`: onboarding finished → the
 * user's project (as `/` would pick it), unless there is nothing to open; otherwise show it.
 */
export function onboardingDecision(ctx: UserContext): OnboardingDecision {
  if (ctx.onboarding?.completed) {
    const landing = landingFor(ctx);
    if (!landing.startsWith("/onboarding/")) return { kind: "redirect", location: landing };
  }
  return { kind: "show" };
}
