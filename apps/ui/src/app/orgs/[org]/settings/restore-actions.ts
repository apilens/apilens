"use server";

// Server Action of organization settings → Deleted projects (#822): restores a deleted project
// before its purge (#753 D8). It re-checks its input (a Server Action is a public POST endpoint),
// calls the API as the signed-in user and answers a sentence to show, never a raw error.
// Authorization is the API's: `manage` on the organization (owners and admins) and a recent
// sign-in (D12), answered as `reauth_required` for the dialog to handle.
import { revalidatePath } from "next/cache";
import { restoreError } from "@/lib/deleted-projects";
import { identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type RestoreResult = { ok: true; project: { slug: string; name: string } } | { ok: false; error: string; code?: string };

const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Restores the deleted project `id` of `org`: its access, keys, apps and slug come back as they were. */
export async function restoreDeletedProject(org: unknown, id: unknown): Promise<RestoreResult> {
  if (typeof org !== "string" || !ORG_SLUG.test(org) || typeof id !== "string" || !UUID.test(id)) {
    return { ok: false, error: restoreError("not_found"), code: "not_found" };
  }
  return withActionSession(async (session) => {
    try {
      const project = await session.call((o) => identity().restoreProject(org, id, o));
      // The switcher and sidebar list the project again without a reload.
      revalidatePath("/", "layout");
      return { ok: true, project: { slug: project.slug, name: project.name } };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: restoreError(err.code), code: err.code };
    }
  });
}
