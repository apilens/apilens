"use server";

// Server Action of the Performance page's app settings (#595): replaces an app's response time
// threshold, the Apdex threshold of its endpoints without their own. It re-checks its input (a
// Server Action is a public POST endpoint), calls the API as the signed-in user and answers a
// sentence to show, never a raw error. Authorization is the API's: `manage_capture` on the project.
import { isProjectSlug } from "@/lib/api-keys";
import { isAppId } from "@/lib/capture-policy";
import { type AppSettings, identity, isApiError } from "@/lib/identity";
import { checkThreshold, thresholdError } from "@/lib/performance";
import { withActionSession } from "@/lib/server-session";

export type SaveAppThresholdResult = { ok: true; settings: AppSettings } | { ok: false; error: string; code?: string };

/** Saves `threshold` (ms, or null for the default) as the response time threshold of app `appId` in `project`. */
export async function saveAppThreshold(project: string, appId: string, threshold: unknown): Promise<SaveAppThresholdResult> {
  if (!isProjectSlug(project) || !isAppId(appId)) return { ok: false, error: thresholdError("not_found"), code: "not_found" };
  const checked = checkThreshold(threshold);
  if (!checked.ok) return { ok: false, error: thresholdError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const settings = await session.call((o) => identity().putAppSettings(appId, { latency_threshold_ms: checked.threshold }, o));
      return { ok: true, settings };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: thresholdError(err.code), code: err.code };
    }
  });
}
