import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type AppThresholdLoad, PerformanceView } from "@/components/performance/performance";
import { getContext, getSession } from "@/lib/auth/server";
import { type AppSettings, type CallOptions, type EndpointTraffic, type ProjectApps, type TrafficLatency, identity, isApiError } from "@/lib/identity";
import { PERF_ENDPOINTS_LIMIT, type PerformanceState, parsePerformanceQuery, performanceHref } from "@/lib/performance";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Performance" };

type SearchParams = Record<string, string | string[] | undefined>;

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

/** The project's apps, the app in scope (`?app=`, else the first) and its threshold. */
async function readThreshold(project: string, q: PerformanceState, next: string): Promise<AppThresholdLoad> {
  const apps = await read<ProjectApps>(next, (o) => identity().projectApps(project, o));
  if (apps === null) return { apps: null, app: null, settings: null };
  const list = apps.apps ?? [];
  const app = list.find((a) => a.slug === q.app) ?? list[0] ?? null;
  if (!app) return { apps: list, app: null, settings: null };
  const settings = await read<AppSettings>(next, (o) => identity().getAppSettings(project, app.id, o));
  return { apps: list, app, settings };
}

// Performance (#595): p50/p75/p95 tiles and trend, the Apdex gauge, the response-time histogram,
// the endpoints by p95 and the app-wide response time threshold, scoped by the range and
// environment in the URL. Saving a threshold refreshes the page, so the Apdex is read again.
export default async function PerformancePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const q = parsePerformanceQuery(sp);
  const next = performanceHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const scope = { range: q.range, env: q.env };
  const [latency, endpoints, threshold] = await Promise.all([
    read<TrafficLatency>(next, (o) => identity().trafficLatency(project, scope, o)),
    read<{ endpoints: EndpointTraffic[] | null }>(next, (o) => identity().listEndpoints(project, { ...scope, limit: PERF_ENDPOINTS_LIMIT }, o)),
    readThreshold(project, q, next),
  ]);

  return (
    <AppShell context={context} project={project} view="performance">
      <PerformanceView
        project={project}
        projectName={found.project.name}
        environments={found.project.environments ?? []}
        query={q}
        latency={latency}
        endpoints={endpoints === null ? null : (endpoints.endpoints ?? [])}
        threshold={threshold}
        params={sp}
      />
    </AppShell>
  );
}
