// Onboarding page guard (#326). Every `/onboarding/<page>` Server Component calls it, so the
// check runs on each navigation (including back/forward), not only on the first load as a
// layout would: signed out → sign up; finished → the project; ahead of the saved step → the
// saved step's page. It also hands the page the saved answers (#327) and home screen (#328), so a
// refresh resumes with what was entered.
import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type HomeScreen, type JoinableOrg, type OnboardingAnswers, identity } from "../identity";
import { ONBOARDING_SIGN_UP_PATH, type OnboardingAllowed, onboardingDecision } from "../onboarding";
import { savedAnswers, savedHome } from "../onboarding-save";
import { isSessionExpired, redirectToRefresh } from "../server-session";
import { getContext, getSession } from "./server";

/** Guards `/onboarding/<page>`; returns the step bar state, saved answers and home screen when the page may be shown. */
export async function requireOnboardingStep(page: string): Promise<OnboardingAllowed & { answers: OnboardingAnswers; home: HomeScreen }> {
  const session = await getSession();
  if (!session.payload) redirect(ONBOARDING_SIGN_UP_PATH);
  const ctx = await getContext(`/onboarding/${page}`);
  const decision = onboardingDecision(ctx, page);
  if (decision.kind === "redirect") redirect(decision.location);
  return { ...decision, answers: savedAnswers(ctx), home: savedHome(ctx) };
}

/**
 * `GET /users/me/joinable-orgs` (#283): the organizations the user may join by verified email
 * domain (#329). `next` is the page's own path, for the refresh round trip.
 */
export const getJoinableOrgs = cache(async (next: string): Promise<JoinableOrg[]> => {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listJoinableOrgs(o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    throw err;
  }
});
