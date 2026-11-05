"use server";

// Server Actions of project settings → Health checks (#608): create and delete a project's active
// HTTP checks. They re-check their input (a Server Action is a public POST endpoint), call the API
// as the signed-in user and answer a sentence to show, never a raw error. Authorization and the
// URL's SSRF guard are the API's (manage_alerts: project admins, organization owners and admins).
import { isProjectSlug } from "@/lib/api-keys";
import { type HealthCheckField, checkHealthCheckInput, healthCheckError } from "@/lib/health-checks";
import { type HealthCheck, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type CreateHealthCheckResult = { ok: true; check: HealthCheck } | { ok: false; error: string; code?: string; field?: HealthCheckField };

export type DeleteHealthCheckResult = { ok: true } | { ok: false; error: string; code?: string };

/** Creates a health check on `project` from the form's `input`. */
export async function createHealthCheck(project: string, input: unknown): Promise<CreateHealthCheckResult> {
  if (!isProjectSlug(project)) return { ok: false, error: healthCheckError("not_found"), code: "not_found" };
  const checked = checkHealthCheckInput(input);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request", field: checked.field };
  return withActionSession(async (session) => {
    try {
      const check = await session.call((o) => identity().createHealthCheck(project, checked.body, o));
      return { ok: true, check };
    } catch (err) {
      if (!isApiError(err)) throw err;
      const detail = err.status === 422 ? err.problem?.detail : undefined;
      return { ok: false, error: healthCheckError(err.code, detail), code: err.code, ...(detail?.startsWith("url ") ? { field: "url" as const } : {}) };
    }
  });
}

/** Deletes health check `id` of `project` and its events. */
export async function deleteHealthCheck(project: string, id: unknown): Promise<DeleteHealthCheckResult> {
  if (!isProjectSlug(project) || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    return { ok: false, error: healthCheckError("not_found"), code: "not_found" };
  }
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().deleteHealthCheck(project, id, o));
      return { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: healthCheckError(err.code), code: err.code };
    }
  });
}
