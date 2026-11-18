"use server";

// Server Action of the endpoint page's settings menu (#593): replaces one endpoint's expected
// status codes, latency threshold and exclusion for an app. It re-checks its input (a Server
// Action is a public POST endpoint), calls the API as the signed-in user and answers a sentence
// to show, never a raw error. Authorization is the API's: `manage_capture` on the project.
import { isProjectSlug } from "@/lib/api-keys";
import { isAppId } from "@/lib/capture-policy";
import { checkSettings, loadSettingsError, parseEndpointRef, settingsError } from "@/lib/endpoint-detail";
import { type EndpointSettings, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type SaveEndpointSettingsResult = { ok: true; settings: EndpointSettings } | { ok: false; error: string; code?: string };

/** Saves `input` as the settings of endpoint `method` `path` of app `appId` in `project`. */
export async function saveEndpointSettings(project: string, appId: string, method: string, path: string, input: unknown): Promise<SaveEndpointSettingsResult> {
  const ep = typeof method === "string" && typeof path === "string" && path.startsWith("/") ? parseEndpointRef(method, path) : null;
  if (!isProjectSlug(project) || !isAppId(appId) || !ep) return { ok: false, error: settingsError("not_found"), code: "not_found" };
  const checked = checkSettings(input);
  if (!checked.ok) return { ok: false, error: settingsError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const settings = await session.call((o) => identity().putEndpointSettings(appId, ep.method, ep.path, checked.settings, o));
      return { ok: true, settings };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: settingsError(err.code), code: err.code };
    }
  });
}

/**
 * Reads the settings of endpoint `method` `path` of app `appId` in `project`, for the endpoint row
 * menu on Traffic (#600), which reads them only when it opens.
 */
export async function loadEndpointSettings(project: string, appId: string, method: string, path: string): Promise<SaveEndpointSettingsResult> {
  const ep = typeof method === "string" && typeof path === "string" && path.startsWith("/") ? parseEndpointRef(method, path) : null;
  if (!isProjectSlug(project) || !isAppId(appId) || !ep) return { ok: false, error: loadSettingsError("not_found"), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      const settings = await session.call((o) => identity().getEndpointSettings(project, appId, ep.method, ep.path, o));
      return { ok: true, settings };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: loadSettingsError(err.code), code: err.code };
    }
  });
}
