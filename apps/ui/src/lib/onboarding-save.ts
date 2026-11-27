// Reading what Welcome and the home screen saved: the answers out of the user context (so a
// refreshed screen starts from them), the home preference, and the sentence for a failed save.
// Answer rules mirror `OnboardingPatchBody` in internal/identity/onboarding.go. Pure, so it can
// be unit tested.
import { z } from "zod";
import type { HomeScreen, OnboardingAnswers, UserContext } from "./identity";

// The API's rules (account.SlugPattern).
const SLUG = /^([a-z0-9][a-z0-9-]{0,62})?$/;

const answerShape = {
  org_slug: z.string().regex(SLUG),
  project_slug: z.string().regex(SLUG),
};

/**
 * The saved answers, for screens to start from. The context carries them as stored
 * (`user.onboarding.answers`); values that do not fit the API's rules are dropped one by one.
 */
export function savedAnswers(ctx: UserContext): OnboardingAnswers {
  const stored = ctx.user.onboarding?.answers;
  const out: Record<string, unknown> = {};
  if (!stored || typeof stored !== "object") return out;
  for (const [key, schema] of Object.entries(answerShape)) {
    const parsed = schema.safeParse(stored[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as OnboardingAnswers;
}

/** The home screens "What should you see first?" offers (`preferences.home` in the API). */
export const HOME_SCREENS = ["endpoints", "requests", "exceptions"] as const satisfies readonly HomeScreen[];

/** The home screen preselected when the user has not picked one. */
const DEFAULT_HOME: HomeScreen = "endpoints";

const homeSchema = z.enum(HOME_SCREENS);

/** Checks a home screen to save (#328); null when it is not one the API accepts. */
export function parseHome(home: unknown): HomeScreen | null {
  const parsed = homeSchema.safeParse(home);
  return parsed.success ? parsed.data : null;
}

/** The saved home screen (`user.preferences.home`), or the default when none (or an unknown one) is saved. */
export function savedHome(ctx: UserContext): HomeScreen {
  return parseHome(ctx.user.preferences?.home) ?? DEFAULT_HOME;
}

/** A sentence for a failed save, by API error code. */
export function saveError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some answers weren’t accepted. Check them and try again.";
    case "rate_limited":
      return "Too many attempts in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens to save your progress. Check your connection and try again.";
    default:
      return "We couldn’t save your progress. Try again in a moment.";
  }
}
