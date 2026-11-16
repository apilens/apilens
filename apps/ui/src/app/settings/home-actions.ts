"use server";

// Server Action of the account Preferences section's "Home screen" card (#994): saves the view `/`
// opens a project on (`PATCH /users/me` `{preferences: {home}}`), the same preference onboarding's
// "What should you see first?" sets. The input is re-checked (a Server Action is a public POST
// endpoint) and failures answer a sentence to show, never a raw error.
import { revalidatePath } from "next/cache";
import { type HomeScreen, identity, isApiError } from "@/lib/identity";
import { parseHome, saveError } from "@/lib/onboarding-save";
import { withActionSession } from "@/lib/server-session";

export type SaveHomeScreenResult = { ok: true; home: HomeScreen } | { ok: false; error: string; code?: string };

/** Saves `home` as the user's home screen. */
export async function saveHomeScreen(home: HomeScreen): Promise<SaveHomeScreenResult> {
  const checked = parseHome(home);
  if (!checked) return { ok: false, error: saveError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const user = await session.call((o) => identity().updateMe({ preferences: { home: checked } }, o));
      revalidatePath("/settings/preferences");
      return { ok: true, home: parseHome(user.preferences?.home) ?? checked };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: saveError(err.code), code: err.code };
    }
  });
}
