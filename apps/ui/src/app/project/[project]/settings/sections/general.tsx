import { type GeneralLoad, ProjectGeneralSettings } from "@/components/project-settings/general";
import { getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** At most this many people are looked through for the creator's name (the API's page limit). */
const PEOPLE_LIMIT = 200;

/**
 * `GET /projects/{slug}`, or null when the API could not answer, plus the names of its creator
 * and of whoever paused it, from the people who can view the project. A name that cannot be found
 * (a former member, a failed lookup) is left out and the card says so.
 */
export async function load({ project, next }: SectionContext): Promise<GeneralLoad> {
  const session = await getSession();
  try {
    const detail = await session.call((o) => identity().getProject(project, o));
    const wanted = [detail.created_by, detail.paused_by].filter((id): id is string => !!id);
    const names: Record<string, string> = {};
    if (wanted.length > 0) {
      try {
        const people = await session.call((o) => identity().projectAccess(project, { limit: PEOPLE_LIMIT }, o));
        for (const m of people.members ?? []) if (wanted.includes(m.user_id)) names[m.user_id] = m.name || m.email;
      } catch (err) {
        if (isSessionExpired(err)) redirectToRefresh(next);
        if (!isApiError(err)) throw err;
      }
    }
    return { project: detail, names };
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(loaded: GeneralLoad, { project, projectName }: SectionContext) {
  return <ProjectGeneralSettings project={project} projectName={projectName} loaded={loaded} />;
}
