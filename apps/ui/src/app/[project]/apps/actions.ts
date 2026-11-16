"use server";

// Server Actions of the Apps page: rename, archive, restore, keep (acknowledge), merge and delete an
// app of a project (`/projects/{slug}/apps/{id}`). Each one re-checks its input (a Server Action is
// a public POST endpoint), calls the API as the signed-in user, revalidates the page and answers a
// sentence to show, never a raw error. Authorization is the API's: `capture.manage`.
import { revalidatePath } from "next/cache";
import { isProjectSlug } from "@/lib/api-keys";
import { appActionError, checkAppName, isManagedAppId } from "@/lib/app-manage";
import { appsHref } from "@/lib/apps";
import { type CallOptions, identity, isApiError } from "@/lib/identity";
import { withActionSession } from "@/lib/server-session";

export type AppActionResult = { ok: true } | { ok: false; error: string; code?: string };

type Call = (o: CallOptions & { accessToken: string }) => Promise<void>;

async function run(project: string, call: Call): Promise<AppActionResult> {
  return withActionSession(async (session) => {
    try {
      await session.call(call);
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: appActionError(err.code, err.problem?.detail), code: err.code };
    }
    revalidatePath(appsHref(project));
    return { ok: true };
  });
}

function checked(project: string, id: string): AppActionResult | null {
  if (!isProjectSlug(project)) return { ok: false, error: appActionError("not_found"), code: "not_found" };
  if (!isManagedAppId(id)) return { ok: false, error: appActionError("not_found"), code: "not_found" };
  return null;
}

/** Renames app `id`; the slug SDKs send does not change. */
export async function renameApp(project: string, id: string, name: string): Promise<AppActionResult> {
  const bad = checked(project, id);
  if (bad) return bad;
  const n = checkAppName(typeof name === "string" ? name : "");
  if (!n.ok) return { ok: false, error: n.error };
  return run(project, (o) => identity().renameApp(project, id, n.name, o));
}

export async function archiveApp(project: string, id: string): Promise<AppActionResult> {
  return checked(project, id) ?? run(project, (o) => identity().archiveApp(project, id, o));
}

export async function restoreApp(project: string, id: string): Promise<AppActionResult> {
  return checked(project, id) ?? run(project, (o) => identity().restoreApp(project, id, o));
}

/** Keeps a new app the SDK created: it is no longer flagged as new. */
export async function acknowledgeApp(project: string, id: string): Promise<AppActionResult> {
  return checked(project, id) ?? run(project, (o) => identity().acknowledgeApp(project, id, o));
}

/** Sends app `id`'s future data to `into`; its past data stays where it is. */
export async function mergeApp(project: string, id: string, into: string): Promise<AppActionResult> {
  const bad = checked(project, id);
  if (bad) return bad;
  if (!isManagedAppId(into) || into === id) return { ok: false, error: "Pick an active app other than this one." };
  return run(project, (o) => identity().mergeApp(project, id, into, o));
}

/** Deletes app `id`: its name is reserved (data rejected) for 30 days, restorable until then. */
export async function deleteApp(project: string, id: string): Promise<AppActionResult> {
  return checked(project, id) ?? run(project, (o) => identity().deleteApp(project, id, o));
}
