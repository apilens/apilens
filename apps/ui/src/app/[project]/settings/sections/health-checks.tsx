import { HealthChecks, type HealthChecksLoad } from "@/components/project-settings/health-checks";
import { getSession } from "@/lib/auth/server";
import { CHECKS_PAGE, EVENTS_SHOWN } from "@/lib/health-checks";
import { identity, isApiError } from "@/lib/identity";
import { parsePage, slicePage } from "@/lib/pagination";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/**
 * The project's apps and environments, its health checks and the latest failures of the checks on
 * the page `search` names (#608): the list is paged, so only those checks' events are fetched.
 * Each part is null when the API could not answer (the page says so).
 */
export async function load({ project, search, next }: SectionContext): Promise<HealthChecksLoad> {
  const session = await getSession();
  const attempt = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return null;
      throw err;
    }
  };
  const [listed, checked] = await Promise.all([
    attempt(() => session.call((o) => identity().projectApps(project, o))),
    attempt(() => session.call((o) => identity().listHealthChecks(project, o))),
  ]);
  const checks = checked ? (checked.health_checks ?? []) : null;
  const events = Object.fromEntries(
    await Promise.all(
      slicePage(checks ?? [], parsePage(search, CHECKS_PAGE)).rows.map(async (c) => {
        const got = await attempt(() => session.call((o) => identity().healthCheckEvents(project, c.id, EVENTS_SHOWN, o)));
        return [c.id, got ? (got.events ?? []) : null] as const;
      }),
    ),
  );
  return { apps: listed ? (listed.apps ?? []) : null, environments: listed?.environments ?? [], checks, events };
}

export function render(load: HealthChecksLoad, { project, projectName, search }: SectionContext) {
  return <HealthChecks project={project} projectName={projectName} load={load} search={search} />;
}
