"use server";

// Server Actions of Explore's saved views (#589): save, rename, share and delete a view of the
// request log. Each re-checks its input (a Server Action is a public POST endpoint), calls the API
// as the signed-in user and answers a sentence to show, never a raw error. Authorization is the
// API's (#578): the creator edits a view, project admins edit shared ones.
import { isProjectSlug } from "@/lib/api-keys";
import { MAX_VIEW_NAME, filtersOfView, viewError, viewFilter } from "@/lib/explore-views";
import { type SavedView, identity, isApiError } from "@/lib/identity";
import { type ServerSession, withActionSession } from "@/lib/server-session";

export type ViewActionResult = { ok: true; view: SavedView } | { ok: false; error: string; code?: string };
export type DeleteViewResult = { ok: true } | { ok: false; error: string; code?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Checked = { ok: true; name: string; filter: Record<string, string>; shared: boolean } | { ok: false; error: string; code: string };

/** The body of a save: a trimmed name, the filters as the log reads them, and the sharing. */
function check(input: unknown): Checked {
  const b = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name === "" || [...name].length > MAX_VIEW_NAME || typeof b.shared !== "boolean") return { ok: false, error: viewError("invalid_request"), code: "invalid_request" };
  const raw = typeof b.filter === "object" && b.filter !== null && !Array.isArray(b.filter) ? (b.filter as Record<string, unknown>) : {};
  return { ok: true, name, filter: viewFilter(filtersOfView({ filter: raw })), shared: b.shared };
}

async function run<T extends { ok: true }>(project: unknown, fn: (session: ServerSession, project: string) => Promise<T>): Promise<T | { ok: false; error: string; code?: string }> {
  if (!isProjectSlug(project)) return { ok: false, error: viewError("not_found"), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      return await fn(session, project);
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: viewError(err.code), code: err.code };
    }
  });
}

/** Saves `input` ({name, filter, shared}) as a new Explore view of `project`, owned by the caller. */
export async function createExploreView(project: string, input: unknown): Promise<ViewActionResult> {
  const c = check(input);
  if (!c.ok) return c;
  return run(project, async (s, p) => ({
    ok: true as const,
    view: await s.call((o) => identity().createSavedView(p, { name: c.name, surface: "explore", filter: c.filter, shared: c.shared }, o)),
  }));
}

/** Replaces the name, filter and sharing of view `id` of `project`. */
export async function updateExploreView(project: string, id: unknown, input: unknown): Promise<ViewActionResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: viewError("not_found"), code: "not_found" };
  const c = check(input);
  if (!c.ok) return c;
  return run(project, async (s, p) => ({
    ok: true as const,
    view: await s.call((o) => identity().updateSavedView(p, id, { name: c.name, filter: c.filter, shared: c.shared }, o)),
  }));
}

/** Deletes view `id` of `project`. */
export async function deleteExploreView(project: string, id: unknown): Promise<DeleteViewResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: viewError("not_found"), code: "not_found" };
  return run(project, async (s, p) => {
    await s.call((o) => identity().deleteSavedView(p, id, o));
    return { ok: true as const };
  });
}
