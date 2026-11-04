// Saving onboarding progress (#327): the schema the `saveOnboarding` Server Action checks its
// input with (a Server Action is a public POST endpoint), mirroring `OnboardingPatchBody` in
// internal/identity/onboarding.go, and reading the saved answers back out of the user context so
// a refreshed screen starts from them. Pure, so it can be unit tested.
import { z } from "zod";
import type { HomeScreen, OnboardingAnswers, UpdateOnboardingRequest, UserContext } from "./identity";

// The API's rules (account.StepPattern, SlugPattern, ChoicePattern, MaxInvited and KeyIDPattern).
const STEP = /^[a-z][a-z0-9_-]{0,31}$/;
const SLUG = /^([a-z0-9][a-z0-9-]{0,62})?$/;
const CHOICE = /^([a-z0-9][a-z0-9._+-]{0,31})?$/;
const MAX_INVITED = 1000;
const KEY_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

const answerShape = {
  org_slug: z.string().regex(SLUG),
  project_slug: z.string().regex(SLUG),
  language: z.string().regex(CHOICE),
  runtime: z.string().regex(CHOICE),
  method: z.string().regex(CHOICE),
  invited: z.number().int().min(0).max(MAX_INVITED),
  api_key_id: z.string().regex(KEY_ID),
};

/** Answers to save; unknown keys are refused, as the API refuses them. */
export const onboardingAnswersSchema = z.strictObject({
  org_slug: answerShape.org_slug.optional(),
  project_slug: answerShape.project_slug.optional(),
  language: answerShape.language.optional(),
  runtime: answerShape.runtime.optional(),
  method: answerShape.method.optional(),
  invited: answerShape.invited.optional(),
  api_key_id: answerShape.api_key_id.optional(),
}) satisfies z.ZodType<OnboardingAnswers>;

/** The body of `PATCH /users/me/onboarding` as the onboarding screens send it. */
export const onboardingSaveSchema = z.strictObject({
  step: z.string().regex(STEP).optional(),
  answers: onboardingAnswersSchema.optional(),
}) satisfies z.ZodType<UpdateOnboardingRequest>;

/** Checks what a screen asked to save; null when any part of it is not allowed. */
export function parseOnboardingSave(step: unknown, answers: unknown): UpdateOnboardingRequest | null {
  const parsed = onboardingSaveSchema.safeParse({ step: step ?? undefined, answers: answers ?? undefined });
  return parsed.success ? parsed.data : null;
}

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
export const DEFAULT_HOME: HomeScreen = "endpoints";

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
