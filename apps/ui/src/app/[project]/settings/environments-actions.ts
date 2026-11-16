"use server";

// Server Actions of project settings → Environments (#816, #753 D11): add, change (production
// flag, colour, hidden), reorder and remove a project's environments. They re-check their input
// (a Server Action is a public POST endpoint), call the API as the signed-in user and answer the
// project's environments as they now are, or a sentence to show, never a raw error.
// Authorization is the API's (`project.update`: project admins and editors).
import { isProjectSlug } from "@/lib/api-keys";
import { ENV_NAME, MAX_ENVIRONMENTS, environmentError, isEnvironmentColor } from "@/lib/environments";
import { type EnvironmentsList, type UpdateEnvironmentRequest, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type EnvironmentsResult = { ok: true; list: EnvironmentsList } | { ok: false; error: string; code?: string };

const refused = (code: string): EnvironmentsResult => ({ ok: false, error: environmentError(code), code });

const isName = (v: unknown): v is string => typeof v === "string" && ENV_NAME.test(v);

/** Runs `change` as the signed-in user, then answers the project's environments. */
async function run(project: string, change: (session: ServerSession) => Promise<EnvironmentsList | null>): Promise<EnvironmentsResult> {
  return withActionSession(async (session) => {
    try {
      const changed = await change(session);
      const list = changed ?? (await session.call((o) => identity().listEnvironments(project, o)));
      return { ok: true, list };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return refused(err.code);
    }
  });
}

/** Adds environment `name` to `project`. */
export async function addEnvironment(project: string, name: unknown): Promise<EnvironmentsResult> {
  const trimmed = typeof name === "string" ? name.trim() : name;
  if (!isProjectSlug(project)) return refused("not_found");
  if (!isName(trimmed)) return refused("invalid_request");
  return run(project, async (session) => {
    await session.call((o) => identity().addEnvironment(project, trimmed, o));
    return null;
  });
}

/** Changes `name`'s production flag, colour (`none` clears it) or hidden state; other fields are refused. */
export async function updateEnvironment(project: string, name: unknown, patch: unknown): Promise<EnvironmentsResult> {
  if (!isProjectSlug(project) || !isName(name)) return refused("not_found");
  if (typeof patch !== "object" || patch === null) return refused("invalid_request");
  const p = patch as Record<string, unknown>;
  const body: UpdateEnvironmentRequest = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "is_production" && typeof v === "boolean") body.is_production = v;
    else if (k === "hidden" && typeof v === "boolean") body.hidden = v;
    else if (k === "color" && (v === "none" || isEnvironmentColor(v))) body.color = v;
    else return refused("invalid_request");
  }
  if (Object.keys(body).length === 0) return refused("invalid_request");
  return run(project, async (session) => {
    await session.call((o) => identity().updateEnvironment(project, name, body, o));
    return null;
  });
}

/** Puts `project`'s environments in the order of `names` (every name at most once). */
export async function reorderEnvironments(project: string, names: unknown): Promise<EnvironmentsResult> {
  if (!isProjectSlug(project)) return refused("not_found");
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_ENVIRONMENTS || !names.every(isName) || new Set(names).size !== names.length) {
    return refused("invalid_request");
  }
  return run(project, (session) => session.call((o) => identity().reorderEnvironments(project, names, o)));
}

/** Removes `name` from `project`; the API refuses one in use (`environment_in_use`): hide it instead. */
export async function removeEnvironment(project: string, name: unknown): Promise<EnvironmentsResult> {
  if (!isProjectSlug(project) || !isName(name)) return refused("not_found");
  return run(project, async (session) => {
    await session.call((o) => identity().removeEnvironment(project, name, o));
    return null;
  });
}
