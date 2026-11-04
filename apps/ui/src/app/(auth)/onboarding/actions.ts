"use server";

// Server Action of the onboarding screens (#327): every Continue saves where the user is and what
// they answered (`PATCH /users/me/onboarding`), so a refresh resumes there. The input is checked
// against the API's schema first (a Server Action is a public POST endpoint); failures answer a
// sentence to show, never a raw error. Invited users (#337) skip the organization and project
// steps: the about step's Continue finishes onboarding instead (`finishInvitedOnboarding`).
import { redirect } from "next/navigation";
import { type HomeScreen, type Onboarding, type OnboardingAnswers, identity, isApiError } from "@/lib/identity";
import { invitedLanding, invitedOrg } from "@/lib/invitations";
import { parseHome, parseOnboardingSave, saveError } from "@/lib/onboarding-save";
import { withActionSession } from "@/lib/server-session";

export type SaveOnboardingResult = { ok: true; onboarding: Onboarding } | { ok: false; error: string; code?: string };

/**
 * Saves the screen to resume at (`step`, omitted to leave it as it is) and merges `answers`
 * into the saved ones.
 */
export async function saveOnboarding(step: string | undefined, answers: OnboardingAnswers = {}): Promise<SaveOnboardingResult> {
  const body = parseOnboardingSave(step, answers);
  if (!body) return { ok: false, error: saveError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const onboarding = await session.call((o) => identity().updateOnboarding(body, o));
      return { ok: true, onboarding };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: saveError(err.code), code: err.code };
    }
  });
}

/** Where the about step continues to for someone who was not invited. */
const ABOUT_NEXT = "/onboarding/join";

/**
 * The about step's "Continue to <org>" for invited users (#337): they joined an organization by
 * invitation, so onboarding is finished and the browser opens the organization's first project.
 * Anyone else continues to the organization step.
 */
export async function finishInvitedOnboarding(): Promise<void> {
  const next = await withActionSession(async (session) => {
    const ctx = await session.call((o) => identity().context(o));
    const org = invitedOrg(ctx);
    if (!org) return ABOUT_NEXT;
    await session.call((o) => identity().updateOnboarding({ completed: true }, o));
    return invitedLanding(ctx, org);
  });
  redirect(next);
}

export type SaveHomeResult = { ok: true; home: HomeScreen } | { ok: false; error: string; code?: string };

/**
 * Saves the "What should you see first?" pick (#328) as the user's home preference
 * (`PATCH /users/me` `{preferences: {home}}`), which decides the view `/` opens a project on.
 */
export async function saveHome(home: HomeScreen): Promise<SaveHomeResult> {
  const checked = parseHome(home);
  if (!checked) return { ok: false, error: saveError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const user = await session.call((o) => identity().updateMe({ preferences: { home: checked } }, o));
      return { ok: true, home: parseHome(user.preferences?.home) ?? checked };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: saveError(err.code), code: err.code };
    }
  });
}
