"use server";

// Server Actions of the onboarding install step (#333). `createInstallKey` creates the ingest key
// named "Onboarding" on the project (`POST /projects/{slug}/api-keys`) and saves its id (never the
// raw key) in the onboarding answers, so a revisit knows a key was made. The raw key is in the
// answer and nowhere else, ever. `finishInstallLater` is "I'll do this later": it finishes
// onboarding and opens the project with a reminder banner.
import { redirect } from "next/navigation";
import { isProjectSlug } from "@/lib/api-keys";
import { identity, isApiError } from "@/lib/identity";
import { INSTALL_KEY_NAME, INSTALL_KEY_SCOPES, LATER_PARAM, LATER_VALUE, installKeyError } from "@/lib/install";
import { homeView } from "@/lib/landing";
import { withActionSession } from "@/lib/server-session";

export interface InstallKey {
  id: string;
  prefix: string;
  /** The raw key: shown once, then gone. */
  key: string;
}

export type CreateInstallKeyResult = { ok: true; key: InstallKey } | { ok: false; error: string; code?: string };

export async function createInstallKey(project: string): Promise<CreateInstallKeyResult> {
  if (!isProjectSlug(project)) return { ok: false, error: installKeyError("not_found"), code: "not_found" };
  return withActionSession(async (session) => {
    let created: InstallKey;
    try {
      const key = await session.call((o) => identity().createApiKey(project, { name: INSTALL_KEY_NAME, scopes: [...INSTALL_KEY_SCOPES] }, o));
      created = { id: key.id, prefix: key.prefix, key: key.key };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: installKeyError(err.code), code: err.code };
    }
    try {
      await session.call((o) => identity().updateOnboarding({ answers: { api_key_id: created.id } }, o));
    } catch (err) {
      // The key exists and this is the only time it can be shown: show it even so. A revisit
      // then offers to create another one.
      if (!isApiError(err)) throw err;
    }
    return { ok: true, key: created };
  });
}

/** "I'll do this later": finishes onboarding and opens `project` with the setup reminder. */
export async function finishInstallLater(project: string): Promise<{ ok: false; error: string }> {
  if (!isProjectSlug(project)) return { ok: false, error: installKeyError("not_found") };
  const next = await withActionSession(async (session) => {
    try {
      const ctx = await session.call((o) => identity().context(o));
      if (!ctx.orgs.some((org) => org.projects.some((p) => p.slug === project))) return { ok: false as const, error: installKeyError("not_found") };
      await session.call((o) => identity().updateOnboarding({ completed: true }, o));
      return `/${project}/${homeView(ctx)}?${LATER_PARAM}=${LATER_VALUE}`;
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false as const, error: "We couldn’t finish setup. Try again in a moment." };
    }
  });
  if (typeof next !== "string") return next;
  redirect(next);
}
