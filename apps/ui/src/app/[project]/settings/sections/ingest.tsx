import { IngestHealth, type IngestLoad } from "@/components/project-settings/ingest-health";
import { getSession } from "@/lib/auth/server";
import { type AppIngestStats, type NamedApp, identity, isApiError } from "@/lib/identity";
import { INGEST_DAYS } from "@/lib/ingest-health";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/**
 * The project's apps, the one `?app=` names (else the first), its ingest-edge counters over the
 * last days and its status (for the SDK counters). Each part is null when the API could not
 * answer; the counters are `off` when the install keeps none (503).
 */
export async function load({ project, search, next }: SectionContext): Promise<IngestLoad> {
  const appSlug = typeof search.app === "string" ? search.app : undefined;
  const session = await getSession();
  const attempt = async <T,>(fn: () => Promise<T>, off?: T): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return off !== undefined && err.status === 503 ? off : null;
      throw err;
    }
  };
  const listed = await attempt(() => session.call((o) => identity().projectApps(project, o)));
  if (!listed) return { apps: null, app: null, stats: null, status: null };
  const apps: NamedApp[] = listed.apps ?? [];
  const app = apps.find((a) => a.slug === appSlug) ?? apps[0] ?? null;
  if (!app) return { apps, app: null, stats: null, status: null };
  const [stats, status] = await Promise.all([
    attempt<AppIngestStats | "off">(() => session.call((o) => identity().appIngestStats(project, app.id, INGEST_DAYS, o)), "off"),
    attempt(() => session.call((o) => identity().appHealthStatus(project, app.id, o))),
  ]);
  return { apps, app, stats, status };
}

export function render(load: IngestLoad, { project, projectName }: SectionContext) {
  return <IngestHealth project={project} projectName={projectName} load={load} />;
}
