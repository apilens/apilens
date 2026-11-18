"use server";

// Server Actions of the default access card on Access › Members (#808, #753 D2): the dry run that
// counts who would lose access, and the change itself. Each re-checks its input (a Server Action
// is a public POST endpoint), calls the API as the signed-in user and answers a sentence to show,
// never a raw error. Authorization is the API's (`access.manage`, a recent sign-in: D12).
import { isProjectSlug } from "@/lib/api-keys";
import { defaultAccessError, isDefaultAccess } from "@/lib/default-access";
import { type DefaultAccessChange, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type DefaultAccessResult = { ok: true; change: DefaultAccessChange } | { ok: false; error: string; code?: string };

async function patch(project: string, def: unknown, dryRun: boolean): Promise<DefaultAccessResult> {
  if (!isProjectSlug(project)) return { ok: false, error: defaultAccessError("not_found"), code: "not_found" };
  if (!isDefaultAccess(def)) return { ok: false, error: defaultAccessError("invalid_request"), code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const change = await session.call((o) => identity().setDefaultAccess(project, def, { dryRun }, o));
      return { ok: true, change };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: defaultAccessError(err.code), code: err.code };
    }
  });
}

/** Asks the API how many people would lose access if `project`'s default became `def`; changes nothing. */
export async function previewDefaultAccess(project: string, def: unknown): Promise<DefaultAccessResult> {
  return patch(project, def, true);
}

/** Sets `project`'s default access to `def`. */
export async function setDefaultAccess(project: string, def: unknown): Promise<DefaultAccessResult> {
  return patch(project, def, false);
}
