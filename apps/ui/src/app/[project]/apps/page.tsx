import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type AppCardData, AppsView } from "@/components/apps/apps";
import { APPS_PAGE, REJECTION_DAYS, cardApps } from "@/lib/app-manage";
import { APPS_RANGE, appsHref } from "@/lib/apps";
import { getContext, getSession } from "@/lib/auth/server";
import {
  type AppRejections,
  type AppStatus,
  type CallOptions,
  type ManagedApp,
  type ProjectApps,
  type TrafficSummary,
  type TrafficTimeseries,
  identity,
  isApiError,
} from "@/lib/identity";
import { type SearchParams, pageRedirect, parsePage, slicePage } from "@/lib/pagination";
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

// Apps overview (#591): one card per active app with its last 24 hours of traffic, health, SDK
// reporting status, SDK version and origin, paged in the URL (`?page=&per=`); the page's traffic
// and status reads run only for the cards shown. Apps come from the SDK, so the page also reads the
// managed list (`GET /projects/{slug}/apps`: origin, new, archived, merged, deleted) and the
// records rejected for app names over the last days.
export default async function AppsPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const query = await searchParams;
  const next = appsHref(project);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const [listed, managedList, rejections] = await Promise.all([
    read<ProjectApps>(next, (o) => identity().projectApps(project, o)),
    read<{ apps: ManagedApp[] | null }>(next, (o) => identity().listManagedApps(project, o)),
    read<AppRejections>(next, (o) => identity().appRejections(project, REJECTION_DAYS, o)),
  ]);
  const managed = managedList ? (managedList.apps ?? []) : null;
  const all = cardApps(managed, listed ? (listed.apps ?? []) : null);

  // A page past the end (apps archived or merged away, or a hand-edited URL) lands on the last page.
  if (all) {
    const fix = pageRedirect(next, query, all.length, APPS_PAGE);
    if (fix) redirect(fix);
  }
  const shown = all ? slicePage(all, parsePage(query, APPS_PAGE)).rows : [];

  const apps: AppCardData[] | null =
    all === null
      ? null
      : await Promise.all(
          shown.map(async (app) => {
            const scope = { range: APPS_RANGE, app: app.id };
            const [status, summary, series] = await Promise.all([
              read<AppStatus>(next, (o) => identity().appHealthStatus(project, app.id, o)),
              read<TrafficSummary>(next, (o) => identity().trafficSummary(project, scope, o)),
              read<TrafficTimeseries>(next, (o) => identity().trafficTimeseries(project, scope, o)),
            ]);
            return { app, managed: managed?.find((m) => m.id === app.id) ?? null, status, summary, points: series === null ? null : (series.points ?? []) };
          }),
        );

  return (
    <AppShell context={context} project={project} view="apps">
      <AppsView
        project={project}
        projectName={found.project.name}
        apps={apps}
        total={all?.length ?? 0}
        managed={managed}
        rejections={rejections}
        params={query}
        now={Date.now()}
      />
    </AppShell>
  );
}
