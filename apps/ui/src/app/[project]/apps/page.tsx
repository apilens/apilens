import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type AppCardData, AppsView } from "@/components/apps/apps";
import { APPS_RANGE, appsHref } from "@/lib/apps";
import { getContext, getSession } from "@/lib/auth/server";
import { type AppStatus, type CallOptions, type ProjectApps, type TrafficSummary, type TrafficTimeseries, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Apps" };

/** One read as the signed-in user: the answer, or null when the API could not answer. */
async function read<T>(next: string, fn: (o: CallOptions & { accessToken: string }) => Promise<T>): Promise<T | null> {
  const session = await getSession();
  try {
    return await session.call(fn);
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

// Apps overview (#591): one card per app with its last 24 hours of traffic, health, SDK reporting
// status and SDK version against the latest release.
export default async function AppsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const next = appsHref(project);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const listed = await read<ProjectApps>(next, (o) => identity().projectApps(project, o));
  const apps: AppCardData[] | null =
    listed === null
      ? null
      : await Promise.all(
          (listed.apps ?? []).map(async (app) => {
            const scope = { range: APPS_RANGE, app: app.id };
            const [status, summary, series] = await Promise.all([
              read<AppStatus>(next, (o) => identity().appHealthStatus(project, app.id, o)),
              read<TrafficSummary>(next, (o) => identity().trafficSummary(project, scope, o)),
              read<TrafficTimeseries>(next, (o) => identity().trafficTimeseries(project, scope, o)),
            ]);
            return { app, status, summary, points: series === null ? null : (series.points ?? []) };
          }),
        );

  return (
    <AppShell context={context} project={project} view="apps">
      <AppsView project={project} projectName={found.project.name} apps={apps} now={Date.now()} />
    </AppShell>
  );
}
