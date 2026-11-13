"use server";

// Server Actions of project settings → Danger zone (#821): pause ingest (typed project name),
// change the slug (#753 D9) and delete the project (typed slug, D8). Resuming is General's
// `resumeProjectIngest`. Each one re-checks its input (a Server Action is a public POST endpoint),
// calls the API as the signed-in user and answers a sentence to show, never a raw error.
// Authorization is the API's: `delete` on the project (project admins); renaming and deleting
// also need a recent sign-in (D12), answered as `reauth_required` for the dialog to handle.
import { revalidatePath } from "next/cache";
import { isProjectSlug } from "@/lib/api-keys";
import { confirmMatches } from "@/lib/confirm";
import { type DeletedProject, type ProjectDetail, identity, isApiError } from "@/lib/identity";
import { projectGeneralError, renameSlugError } from "@/lib/project-general";
import { withActionSession } from "@/lib/server-session";

export type DangerResult<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const badProject = { ok: false as const, error: projectGeneralError("not_found", "danger"), code: "not_found" };
const failed = (code: string | undefined) => ({ ok: false as const, error: projectGeneralError(code, "danger"), code });

/**
 * Pauses ingest for `project` once `typed` matches the project's current name; pausing a project
 * that is already paused changes nothing.
 */
export async function pauseProjectIngest(project: string, typed: unknown): Promise<DangerResult<{ project: ProjectDetail }>> {
  if (!isProjectSlug(project)) return badProject;
  const phrase = str(typed);
  return withActionSession(async (session) => {
    try {
      const current = await session.call((o) => identity().getProject(project, o));
      if (!confirmMatches(current.name, phrase)) {
        return { ok: false, error: "Type the project’s name exactly to confirm.", code: "confirmation_mismatch" };
      }
      const paused = await session.call((o) => identity().pauseProject(project, o));
      return { ok: true, project: paused };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return failed(err.code);
    }
  });
}

/** Gives `project` the slug `next`; the old one redirects and stays reserved for 30 days. */
export async function renameProjectSlug(project: string, next: unknown): Promise<DangerResult<{ project: ProjectDetail }>> {
  if (!isProjectSlug(project)) return badProject;
  const slug = str(next).trim();
  const problem = renameSlugError(project, slug);
  if (problem) return { ok: false, error: problem, code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const renamed = await session.call((o) => identity().renameProject(project, slug, o));
      // Every link in the sidebar, switcher and breadcrumb carries the slug.
      revalidatePath("/", "layout");
      return { ok: true, project: renamed };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return failed(err.code);
    }
  });
}

/**
 * Deletes `project` once `typed` is its slug. The project is gone for everyone at once and
 * restorable by an organization admin until `purge_after`.
 */
export async function deleteProjectNow(project: string, typed: unknown): Promise<DangerResult<{ deleted: DeletedProject }>> {
  if (!isProjectSlug(project)) return badProject;
  if (!confirmMatches(project, str(typed))) return failed("confirmation_mismatch");
  return withActionSession(async (session) => {
    try {
      const deleted = await session.call((o) => identity().deleteProject(project, project, o));
      // The switcher and sidebar must drop the project without a reload.
      revalidatePath("/", "layout");
      return { ok: true, deleted };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return failed(err.code);
    }
  });
}
