import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EnvMemory } from "@/components/env-memory";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { TrafficView } from "@/components/traffic/traffic";
import { TrafficMenu } from "@/components/traffic/menu";
import { getContext, getSession } from "@/lib/auth/server";
import { visibleEnvironments } from "@/lib/environments";
import {
  type CallOptions,
  type EndpointTraffic,
  type EnvironmentsList,
  type ProjectApps,
  type RequestFacets,
  type TrafficSummary,
  type TrafficTimeseries,
  identity,
  isApiError,
} from "@/lib/identity";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";
import { withScopeDefaults } from "@/lib/scope-defaults";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import { DEFAULT_RANGE, ENDPOINTS_LIMIT, TRAFFIC_RANGES, parseTrafficQuery, trafficHref } from "@/lib/traffic";

export const metadata: Metadata = { title: "Traffic" };

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

// Traffic (#592): the KPI strip, one chart (requests by status, or response time), the top
// endpoints, consumers and status codes, and the endpoints table, scoped by the range,
// environment and app in the URL.
export default async function TrafficPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const raw = await searchParams;
  const next = trafficHref(project, parseTrafficQuery(raw));
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  // No range or env in the URL (#993): the range that covers the project's first data, production.
  const { params: sp, urlParams, envExplicit } = await withScopeDefaults(raw, {
    environments: found.project.environments ?? [],
    firstAt: async () => (await read(next, (o) => identity().ingestStatus(project, o)))?.first_at,
    ranges: TRAFFIC_RANGES,
    fallbackRange: DEFAULT_RANGE,
  });
  const q = parseTrafficQuery(sp);

  // `?app=` (#976) narrows every read to one app; without it they count all apps.
  const scope = {
    range: q.range,
    env: q.env,
    ...(q.app ? { app: q.app } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.path ? { path: q.path } : {}),
    ...(q.from && q.to ? { from: q.from, to: q.to } : {}),
  };
  // The sidebar's facets (and the filter bar's suggestions): requests per value of each field
  // under every other condition (a field's own is left out, so its other values stay listed).
  const cond: Record<"env" | "app" | "method" | "path", string | null> = {
    env: q.env && q.env !== "all" ? `env:eq:${q.env}` : null,
    app: q.app ? `app:eq:${q.app.toLowerCase()}` : null,
    method: q.method ? `method:eq:${q.method}` : null,
    path: q.path ? `path:eq:${q.path}` : null,
  };
  const facet = (field: "env" | "app" | "method" | "path", limit: number) => {
    const filter = Object.entries(cond).flatMap(([k, v]) => (k === field || !v ? [] : [v]));
    return read<RequestFacets>(next, (o) =>
      identity().requestFacets(project, { range: q.range, field, limit, ...(q.from && q.to ? { from: q.from, to: q.to } : {}), ...(filter.length ? { filter } : {}) }, o),
    );
  };
  const [summary, series, endpoints, apps, envs, methods, envCounts, appCounts, pathCounts] = await Promise.all([
    read<TrafficSummary>(next, (o) => identity().trafficSummary(project, scope, o)),
    read<TrafficTimeseries>(next, (o) => identity().trafficTimeseries(project, scope, o)),
    read<{ endpoints: EndpointTraffic[] | null }>(next, (o) => identity().listEndpoints(project, { ...scope, limit: ENDPOINTS_LIMIT }, o)),
    // The app filter and App column (#976) and the apps whose endpoint settings the row menus edit
    // (#600); without them there is no filter and the rows have no menu.
    read<ProjectApps>(next, (o) => identity().projectApps(project, o)),
    // The picker follows Project settings › Environments (#816): their order, hidden ones left out.
    read<EnvironmentsList>(next, (o) => identity().listEnvironments(project, o)),
    facet("method", 12),
    facet("env", 20),
    facet("app", 20),
    facet("path", 10),
  ]);
  const facetValues = (f: RequestFacets | null) => (f === null ? null : (f.values ?? []));

  return (
    <AppShell
      context={context}
      project={project}
      view="traffic"
      menu={
        <TrafficMenu
          project={project}
          query={q}
          apps={apps?.apps ?? null}
          envs={facetValues(envCounts)}
          appCounts={facetValues(appCounts)}
          methods={facetValues(methods)}
          paths={facetValues(pathCounts)}
        />
      }
    >
      <EnvMemory project={project} env={q.env} explicit={envExplicit} environments={found.project.environments ?? []} />
      {/* "I’ll do this later" on the onboarding install step (#333) lands on the home view (#994), which can be this one. */}
      {raw[LATER_PARAM] === LATER_VALUE ? <SetupReminder project={project} /> : null}
      <TrafficView
        project={project}
        projectName={found.project.name}
        environments={envs ? visibleEnvironments(envs.environments ?? []).map((e) => e.name) : (found.project.environments ?? [])}
        query={q}
        summary={summary}
        points={series === null ? null : (series.points ?? [])}
        endpoints={endpoints === null ? null : (endpoints.endpoints ?? [])}
        apps={apps?.apps ?? null}
        methods={methods === null ? null : (methods.values ?? [])}

        // Links and forms keep the URL form of the scope (`env=all` stays all environments).
        params={urlParams}
      />
    </AppShell>
  );
}
