// Onboarding page guard (#326). Every `/onboarding/<page>` Server Component calls it, so the
// check runs on each navigation (including back/forward), not only on the first load as a
// layout would: signed out → sign up; finished → the project; ahead of the saved step → the
// saved step's page.
import "server-only";
import { redirect } from "next/navigation";
import { ONBOARDING_SIGN_UP_PATH, type OnboardingAllowed, onboardingDecision } from "../onboarding";
import { getContext, getSession } from "./server";

/** Guards `/onboarding/<page>`; returns the step bar state when the page may be shown. */
export async function requireOnboardingStep(page: string): Promise<OnboardingAllowed> {
  const session = await getSession();
  if (!session.payload) redirect(ONBOARDING_SIGN_UP_PATH);
  const decision = onboardingDecision(await getContext(`/onboarding/${page}`), page);
  if (decision.kind === "redirect") redirect(decision.location);
  return decision;
}
