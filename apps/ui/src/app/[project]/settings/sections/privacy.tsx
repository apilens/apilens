import { PrivacySettings } from "@/components/project-settings/privacy";
import { getSession } from "@/lib/auth/server";
import { type PrivacyPolicy, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}/privacy-policy` (project-wide), or null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<PrivacyPolicy | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getPrivacyPolicy(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(policy: PrivacyPolicy | null, { project, projectName }: SectionContext) {
  return <PrivacySettings project={project} projectName={projectName} policy={policy} />;
}
