"use server";

// Server Action of the onboarding screens (#327): every Continue saves where the user is and what
// they answered (`PATCH /users/me/onboarding`), so a refresh resumes there. The input is checked
// against the API's schema first (a Server Action is a public POST endpoint); failures answer a
// sentence to show, never a raw error.
import { type Onboarding, type OnboardingAnswers, identity, isApiError } from "@/lib/identity";
import { parseOnboardingSave, saveError } from "@/lib/onboarding-save";
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
