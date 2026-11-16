import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EnvMemory } from "@/components/env-memory";
import { type AppThresholdLoad, PerformanceView } from "@/components/performance/performance";
import { getContext, getSession } from "@/lib/auth/server";
import { type AppSettings, type CallOptions, type EndpointTraffic, type ProjectApps, type RequestRow, type TrafficLatency, identity, isApiError } from "@/lib/identity";
import { PERF_ENDPOINTS_LIMIT, type PerformanceState, SLOWEST_LIMIT, parsePerformanceQuery, performanceHref } from "@/lib/performance";
import { findProject } from "@/lib/scope";
import { withScopeDefaults } from "@/lib/scope-defaults";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import { DEFAULT_RANGE, TRAFFIC_RANGES } from "@/lib/traffic";

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

/**
 * The project's apps and the app the settings dialog opens on with its threshold: the app in scope
 * (`?app=`, #976), else the first. `scoped` says whether that app is the page's whole scope (the
 * filter names it, or the project has only it), so the Apdex explanation may name its threshold.
 */
async function readThreshold(project: string, q: PerformanceState, next: string): Promise<AppThresholdLoad> {
  const apps = await read<ProjectApps>(next, (o) => identity().projectApps(project, o));
  if (apps === null) return { apps: null, app: null, settings: null, scoped: false };
  const list = apps.apps ?? [];
  const inScope = list.find((a) => a.id === q.app) ?? null;
  const app = inScope ?? list[0] ?? null;
  const scoped = inScope !== null || (!q.app && list.length === 1);
  if (!app) return { apps: list, app: null, settings: null, scoped: false };
  const settings = await read<AppSettings>(next, (o) => identity().getAppSettings(project, app.id, o));
  return { apps: list, app, settings, scoped };
}

// Performance (#595): p50/p75/p95 tiles and trend, the Apdex gauge, the response-time histogram,
// the slowest requests, the endpoints by time spent (#1001) and the app-wide response time threshold, scoped by the range and
// environment in the URL. Saving a threshold refreshes the page, so the Apdex is read again.
export default async function PerformancePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const raw = await searchParams;
  const next = performanceHref(project, parsePerformanceQuery(raw));
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  // No range or env in the URL (#993): the range that covers the project's first data, production.
  const { params: sp, envExplicit } = await withScopeDefaults(raw, {
    environments: found.project.environments ?? [],
    firstAt: async () => (await read(next, (o) => identity().ingestStatus(project, o)))?.first_at,
    ranges: TRAFFIC_RANGES,
    fallbackRange: DEFAULT_RANGE,
  });
  const q = parsePerformanceQuery(sp);

  // `?app=` (#976) narrows the reads to one app; without it they count all apps.
  const scope = { range: q.range, env: q.env, ...(q.app ? { app: q.app } : {}) };
  const [latency, endpoints, slowest, threshold] = await Promise.all([
    read<TrafficLatency>(next, (o) => identity().trafficLatency(project, scope, o)),
    read<{ endpoints: EndpointTraffic[] | null }>(next, (o) => identity().listEndpoints(project, { ...scope, limit: PERF_ENDPOINTS_LIMIT }, o)),
    // Slowest requests (#1001): where "why is it slow" ends, at one request.
    read<{ requests: RequestRow[] | null }>(next, (o) => identity().slowestRequests(project, { ...scope, limit: SLOWEST_LIMIT }, o)),
    readThreshold(project, q, next),
  ]);

  return (
    <AppShell context={context} project={project} view="performance">
      <EnvMemory project={project} env={q.env} explicit={envExplicit} environments={found.project.environments ?? []} />
      <PerformanceView
        project={project}
        projectName={found.project.name}
        environments={found.project.environments ?? []}
        query={q}
        latency={latency}
        endpoints={endpoints === null ? null : (endpoints.endpoints ?? [])}
        slowest={slowest === null ? null : (slowest.requests ?? [])}
        threshold={threshold}
      />
    </AppShell>
  );
}
