"use server";

// Server Actions of project settings → General (#815): saves the project's name and description
// (`PATCH /projects/{slug}`) and resumes a paused project's ingest. Each one re-checks its input
// (a Server Action is a public POST endpoint), calls the API as the signed-in user and answers a
// sentence to show, never a raw error. Authorization is the API's: `edit` on the project for the
// details (project admins and editors), `delete` for resuming (project admins).
import { revalidatePath } from "next/cache";
import { isProjectSlug } from "@/lib/api-keys";
import { type ProjectDetail, identity, isApiError } from "@/lib/identity";
import { type GeneralErrors, checkGeneral, projectGeneralError } from "@/lib/project-general";
import { withActionSession } from "@/lib/server-session";

export type SaveProjectGeneralResult =
  | { ok: true; project: ProjectDetail }
  | { ok: false; error: string; code?: string; errors?: GeneralErrors };

export type ResumeProjectResult = { ok: true; project: ProjectDetail } | { ok: false; error: string; code?: string };

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Saves `draft` ({name, description}) as `project`'s details. `current` is what the form showed,
 * so only the fields that changed are sent; nothing changed answers the project as it is.
 */
export async function saveProjectGeneral(project: string, current: unknown, draft: unknown): Promise<SaveProjectGeneralResult> {
  if (!isProjectSlug(project)) return { ok: false, error: projectGeneralError("not_found"), code: "not_found" };
  const c = (current ?? {}) as Record<string, unknown>;
  const d = (draft ?? {}) as Record<string, unknown>;
  const was = { name: str(c.name), description: str(c.description) };
  const next = { name: str(d.name), description: str(d.description) };
  if (was.name === null || was.description === null || next.name === null || next.description === null) {
    return { ok: false, error: projectGeneralError("invalid_request"), code: "invalid_request" };
  }
  const checked = checkGeneral({ name: was.name, description: was.description }, { name: next.name, description: next.description });
  if (!checked.ok) return { ok: false, error: "Fix the highlighted fields to save.", code: "invalid_request", errors: checked.errors };
  const body = checked.body;
  return withActionSession(async (session) => {
    try {
      const saved = await session.call((o) =>
        Object.keys(body).length === 0 ? identity().getProject(project, o) : identity().updateProject(project, body, o),
      );
      // The name shows in the sidebar and the breadcrumb too.
      if (body.name !== undefined) revalidatePath("/", "layout");
      return { ok: true, project: saved };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: projectGeneralError(err.code), code: err.code };
    }
  });
}

/** Resumes ingest for `project`; resuming a project that is not paused changes nothing. */
export async function resumeProjectIngest(project: string): Promise<ResumeProjectResult> {
  if (!isProjectSlug(project)) return { ok: false, error: projectGeneralError("not_found", "danger"), code: "not_found" };
  return withActionSession(async (session) => {
    try {
      const resumed = await session.call((o) => identity().resumeProject(project, o));
      // Clears the paused banner every project page shows (#823).
      revalidatePath("/", "layout");
      return { ok: true, project: resumed };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: projectGeneralError(err.code, "danger"), code: err.code };
    }
  });
}
