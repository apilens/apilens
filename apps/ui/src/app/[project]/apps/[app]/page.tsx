import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AppDetailView } from "@/components/apps/app-detail";
import { APPS_RANGE, APP_DEPLOYS_RANGE, APP_RECENT_DEPLOYS, APP_TOP_ENDPOINTS, appHref } from "@/lib/apps";
import { getContext, getSession } from "@/lib/auth/server";
import {
  type AppStatus,
  type CallOptions,
  type DeployChanges,
  type EndpointTraffic,
  type ProjectApps,
  type TrafficSummary,
  identity,
  isApiError,
} from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

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

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }): Promise<Metadata> {
  const { app } = await params;
  return { title: app };
}

// One app (service), opened from the Apps overview (#591): its overview (#995). Header with the
// app's name, SDKs, environments and health; requests, 5xx rate and p95 of the app over the
// cards' range; its busiest endpoints (each opening the endpoint's page scoped to the app); its SDK
// instances and its recent deploys. An app with no data yet shows how to set the SDK up.
export default async function AppPage({ params }: { params: Promise<{ project: string; app: string }> }) {
  const { project, app: slug } = await params;
  const next = appHref(project, slug);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const listed = await read<ProjectApps>(next, (o) => identity().projectApps(project, o));
  const app = listed ? (listed.apps ?? []).find((a) => a.slug === slug) : undefined;
  // A known list without the app is a 404; an unreadable list still renders the page's error.
  if (listed && !app) notFound();

  let status: AppStatus | null = null;
  let summary: TrafficSummary | null = null;
  let endpoints: { endpoints: EndpointTraffic[] | null } | null = null;
  let deploys: DeployChanges | null = null;
  if (app) {
    const scope = { range: APPS_RANGE, app: app.id };
    [status, summary, endpoints, deploys] = await Promise.all([
      read<AppStatus>(next, (o) => identity().appHealthStatus(project, app.id, o)),
      read<TrafficSummary>(next, (o) => identity().trafficSummary(project, scope, o)),
      read<{ endpoints: EndpointTraffic[] | null }>(next, (o) => identity().listEndpoints(project, { ...scope, limit: APP_TOP_ENDPOINTS }, o)),
      read<DeployChanges>(next, (o) => identity().deployChanges(project, { range: APP_DEPLOYS_RANGE, limit: APP_RECENT_DEPLOYS, app: app.id }, o)),
    ]);
  }

  return (
    <AppShell context={context} project={project} view="apps">
      <AppDetailView
        project={project}
        projectName={found.project.name}
        slug={slug}
        app={app ?? null}
        status={status}
        summary={summary}
        endpoints={endpoints === null ? null : (endpoints.endpoints ?? []).filter((e) => !app || !e.app_id || e.app_id === app.id)}
        deploys={deploys === null ? null : (deploys.deploys ?? [])}
        now={Date.now()}
      />
    </AppShell>
  );
}
