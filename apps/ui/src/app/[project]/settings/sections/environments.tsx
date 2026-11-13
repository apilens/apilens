import { EnvironmentsSection } from "@/components/project-settings/environments";
import { getSession } from "@/lib/auth/server";
import { type EnvironmentsList, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}/environments` (hidden ones included, in order), or null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<EnvironmentsList | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().listEnvironments(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(list: EnvironmentsList | null, { project, projectName }: SectionContext) {
  return <EnvironmentsSection project={project} projectName={projectName} list={list} />;
}
