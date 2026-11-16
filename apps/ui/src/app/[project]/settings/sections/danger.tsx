import { type DangerLoad, ProjectDangerZone } from "@/components/project-settings/danger";
import { getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { PROJECT_SLUG } from "@/lib/project-general";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}` (name, paused state), or null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<DangerLoad> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getProject(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(loaded: DangerLoad, { project, projectName, context, search }: SectionContext) {
  const org = findProject(context, project)?.org.slug ?? loaded?.org_slug ?? "";
  // `?renamed=<old slug>`: the page the rename landed on says so (#821).
  const renamed = typeof search.renamed === "string" && PROJECT_SLUG.test(search.renamed) ? search.renamed : null;
  return <ProjectDangerZone project={project} projectName={projectName} org={org} loaded={loaded} renamedFrom={renamed} />;
}
