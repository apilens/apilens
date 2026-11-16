"use server";

// Server Action of project settings → Integrations (#820): sets or removes the project's source
// repository link (`PATCH /projects/{slug}` with `repository_url`). It re-checks its input (a
// Server Action is a public POST endpoint), calls the API as the signed-in user and answers a
// sentence to show; when the API refuses the link, the sentence is the API's reason.
import { isProjectSlug } from "@/lib/api-keys";
import { type Project, identity, isApiError } from "@/lib/identity";
import { checkRepositoryUrl, repositoryError } from "@/lib/repository";
import { withActionSession } from "@/lib/server-session";

export type SaveRepositoryResult = { ok: true; project: Project } | { ok: false; error: string; code?: string };

/** Saves `url` as the repository link of `project`; "" removes it. */
export async function saveRepositoryUrl(project: string, url: unknown): Promise<SaveRepositoryResult> {
  if (!isProjectSlug(project)) return { ok: false, error: repositoryError("not_found"), code: "not_found" };
  if (typeof url !== "string") return { ok: false, error: repositoryError("invalid_request"), code: "invalid_request" };
  const checked = checkRepositoryUrl(url);
  if (!checked.ok) return { ok: false, error: checked.error, code: "invalid_request" };
  return withActionSession(async (session) => {
    try {
      const saved = await session.call((o) => identity().updateProject(project, { repository_url: checked.url }, o));
      return { ok: true, project: saved };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: repositoryError(err.code, err.problem?.detail), code: err.code };
    }
  });
}
