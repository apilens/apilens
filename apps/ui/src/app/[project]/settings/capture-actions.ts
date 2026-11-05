"use server";

// Server Action of project settings → Capture (#598): replaces an app's remote capture policy.
// It re-checks its input (a Server Action is a public POST endpoint), calls the API as the
// signed-in user and answers a sentence to show, never a raw error. Authorization is the API's:
// `project#manage_capture` (project admins, organization owners and admins).
import { isProjectSlug } from "@/lib/api-keys";
import { captureError, checkPolicy, isAppId } from "@/lib/capture-policy";
import { type CapturePolicy, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type SaveCapturePolicyResult = { ok: true; policy: CapturePolicy } | { ok: false; error: string; code?: string };

/** Saves `input` as the capture policy of app `appId` in `project`. */
export async function saveCapturePolicy(project: string, appId: string, input: unknown): Promise<SaveCapturePolicyResult> {
  if (!isProjectSlug(project) || !isAppId(appId)) return { ok: false, error: captureError("not_found"), code: "not_found" };
  const checked = checkPolicy(input);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const policy = await session.call((o) => identity().putCapturePolicy(appId, checked.policy, o));
      return { ok: true, policy };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: captureError(err.code), code: err.code };
    }
  });
}
