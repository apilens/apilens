import { CaptureSettings, type CaptureLoad } from "@/components/project-settings/capture";
import { getSession } from "@/lib/auth/server";
import { type NamedApp, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/**
 * The project's apps (`GET /project`), the one `?app=` names (else the first), its capture policy
 * and what its SDKs reported. Each part is null when the API could not answer (the page says so).
 */
export async function load({ project, search, next }: SectionContext): Promise<CaptureLoad> {
  const appSlug = typeof search.app === "string" ? search.app : undefined;
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
  const listed = await attempt(() => session.call((o) => identity().projectApps(project, o)));
  if (!listed) return { apps: null, app: null, policy: null, reports: null };
  const apps: NamedApp[] = listed.apps ?? [];
  const app = apps.find((a) => a.slug === appSlug) ?? apps[0] ?? null;
  if (!app) return { apps, app: null, policy: null, reports: null };
  const [policy, reports] = await Promise.all([
    attempt(() => session.call((o) => identity().getCapturePolicy(app.id, o))),
    attempt(() => session.call((o) => identity().appReports(app.id, o))),
  ]);
  return { apps, app, policy, reports: reports ? (reports.environments ?? []) : null };
}

export function render(load: CaptureLoad, { project, projectName, context }: SectionContext) {
  return <CaptureSettings key={load.app?.id ?? "none"} project={project} projectName={projectName} userId={context.user.id} load={load} />;
}
