import { IntegrationsSettings } from "@/components/project-settings/integrations";
import { getSession } from "@/lib/auth/server";
import { type Project, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}` for its repository link, or null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<Project | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getProject(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(loaded: Project | null, { project, projectName }: SectionContext) {
  return <IntegrationsSettings project={project} projectName={projectName} loaded={loaded} />;
}
