// Onboarding page guard (#326). The Welcome Server Component calls it, so the check runs on each
// navigation (including back/forward), not only on the first load as a layout would: signed out
// → sign up; finished → the project.
import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type JoinableOrg, type MyInvitation, identity } from "../identity";
import { ONBOARDING_SIGN_UP_PATH, onboardingDecision } from "../onboarding";
import { isSessionExpired, redirectToRefresh } from "../server-session";
import { getContext, getSession } from "./server";

/** Guards the Welcome page: signs out visitors and redirects away unless it may be shown. */
export async function requireOnboardingStep(page: string): Promise<void> {
  const session = await getSession();
  if (!session.payload) redirect(ONBOARDING_SIGN_UP_PATH);
  const ctx = await getContext(`/onboarding/${page}`);
  const decision = onboardingDecision(ctx);
  if (decision.kind === "redirect") redirect(decision.location);
}

/**
 * `GET /users/me/invitations`: the invitations waiting for the user's verified address. They are
 * an extra offer on Welcome, so a failed list answers none rather than taking the screen (and
 * with it the only way to create an organization) down; the emailed link still works.
 * `next` is the page's own path, for the refresh round trip.
 */
export const getMyInvitations = cache(async (next: string): Promise<MyInvitation[]> => {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listMyInvitations(o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    return [];
  }
});

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
