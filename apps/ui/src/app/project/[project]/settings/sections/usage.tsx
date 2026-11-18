import { type UsageLoad, UsageSection } from "@/components/project-settings/usage";
import { getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { USAGE_DAYS } from "@/lib/project-usage";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** The project's usage over the last days; `off` when the install keeps no counters (503), null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<UsageLoad> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().projectUsage(project, USAGE_DAYS, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return err.status === 503 ? "off" : null;
    throw err;
  }
}

export function render(usage: UsageLoad, { project, projectName }: SectionContext) {
  return <UsageSection project={project} projectName={projectName} usage={usage} />;
}
