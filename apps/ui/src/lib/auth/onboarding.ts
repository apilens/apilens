// Onboarding page guard (#326). Every `/onboarding/<page>` Server Component calls it, so the
// check runs on each navigation (including back/forward), not only on the first load as a
// layout would: signed out → sign up; finished → the project; ahead of the saved step → the
// saved step's page. It also hands the page the saved answers (#327), so a refresh resumes with
// what was entered.
import "server-only";
import { redirect } from "next/navigation";
import type { OnboardingAnswers } from "../identity";
import { ONBOARDING_SIGN_UP_PATH, type OnboardingAllowed, onboardingDecision } from "../onboarding";
import { savedAnswers } from "../onboarding-save";
import { getContext, getSession } from "./server";

/** Guards `/onboarding/<page>`; returns the step bar state and saved answers when the page may be shown. */
export async function requireOnboardingStep(page: string): Promise<OnboardingAllowed & { answers: OnboardingAnswers }> {
  const session = await getSession();
  if (!session.payload) redirect(ONBOARDING_SIGN_UP_PATH);
  const ctx = await getContext(`/onboarding/${page}`);
  const decision = onboardingDecision(ctx, page);
  if (decision.kind === "redirect") redirect(decision.location);
  return { ...decision, answers: savedAnswers(ctx) };
}
