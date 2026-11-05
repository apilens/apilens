"use server";

// Server Action of the Errors page's "Mark as expected" (#594): adds one status code to the
// expected status codes of one endpoint, so every dashboard read stops counting it as an error.
// Endpoint settings are kept per app and the errors dashboard groups endpoints across apps, so the
// code is added for the endpoint in every app of the project, each app's other settings kept as
// saved. It re-checks its input (a Server Action is a public POST endpoint), calls the API as the
// signed-in user and answers a sentence to show, never a raw error. Authorization is the API's:
// `manage_capture` on the project. Marking a code that already is expected changes nothing.
import { isProjectSlug } from "@/lib/api-keys";
import { MAX_EXPECTED, parseEndpointRef } from "@/lib/endpoint-detail";
import { isErrorCode, markExpectedError, withExpectedCode } from "@/lib/errors";
import { identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type MarkExpectedResult = { ok: true } | { ok: false; error: string; code: string };

const fail = (code: string): MarkExpectedResult => ({ ok: false, error: markExpectedError(code), code });

/** Marks status `code` as expected for endpoint `method` `path` in every app of `project`. */
export async function markStatusExpected(project: string, method: string, path: string, code: number): Promise<MarkExpectedResult> {
  const ep = typeof method === "string" && typeof path === "string" && path.startsWith("/") ? parseEndpointRef(method, path) : null;
  if (!isProjectSlug(project) || !ep) return fail("not_found");
  if (!isErrorCode(code)) return fail("invalid_request");
  return withActionSession(async (session) => {
    try {
      const { apps } = await session.call((o) => identity().projectApps(project, o));
      const list = apps ?? [];
      if (list.length === 0) return fail("no_apps");
      for (const app of list) {
        const saved = await session.call((o) => identity().getEndpointSettings(project, app.id, ep.method, ep.path, o));
        const next = withExpectedCode(saved, code);
        if (!next) continue;
        if (next.expected_status_codes.length > MAX_EXPECTED) return fail("too_many");
        await session.call((o) => identity().putEndpointSettings(app.id, ep.method, ep.path, next, o));
      }
      return { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return fail(err.code);
    }
  });
}
