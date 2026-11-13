import { type SdkSetupLoad, SdkSetup } from "@/components/project-settings/sdk-setup";
import { getSession } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/**
 * The project's apps with what each app's SDKs reported per environment (`GET /apps/{id}/metadata`)
 * and when the project's data last arrived (`GET /projects/{slug}/ingest-status`). Each part is
 * null when the API could not answer (the page says so).
 */
export async function load({ project, next }: SectionContext): Promise<SdkSetupLoad> {
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
  const [listed, ingest] = await Promise.all([
    attempt(() => session.call((o) => identity().projectApps(project, o))),
    attempt(() => session.call((o) => identity().ingestStatus(project, o))),
  ]);
  const apps = listed ? await Promise.all((listed.apps ?? []).map(async (app) => {
    const reports = await attempt(() => session.call((o) => identity().appReports(app.id, o)));
    return { app, reports: reports ? (reports.environments ?? []) : null };
  })) : null;
  return { apps, ingest, ingestUrl: env().publicIngestUrl };
}

export function render(load: SdkSetupLoad, { project, projectName }: SectionContext) {
  return <SdkSetup project={project} projectName={projectName} load={load} />;
}
