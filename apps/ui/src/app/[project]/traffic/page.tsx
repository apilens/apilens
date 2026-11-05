import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { TrafficView } from "@/components/traffic/traffic";
import { getContext, getSession } from "@/lib/auth/server";
import { type CallOptions, type EndpointTraffic, type ProjectApps, type TrafficSummary, type TrafficTimeseries, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import { ENDPOINTS_LIMIT, parseTrafficQuery, trafficHref } from "@/lib/traffic";

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

// Traffic (#592): requests, errors and latency tiles, the status-split timeseries and the
// endpoints table, scoped by the range and environment in the URL.
export default async function TrafficPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const q = parseTrafficQuery(await searchParams);
  const next = trafficHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const scope = { range: q.range, env: q.env };
  const [summary, series, endpoints, apps] = await Promise.all([
    read<TrafficSummary>(next, (o) => identity().trafficSummary(project, scope, o)),
    read<TrafficTimeseries>(next, (o) => identity().trafficTimeseries(project, scope, o)),
    read<{ endpoints: EndpointTraffic[] | null }>(next, (o) => identity().listEndpoints(project, { ...scope, limit: ENDPOINTS_LIMIT }, o)),
    // The apps whose endpoint settings the row menus edit (#600); without them the rows have no menu.
    read<ProjectApps>(next, (o) => identity().projectApps(project, o)),
  ]);

  return (
    <AppShell context={context} project={project} view="traffic">
      <TrafficView
        project={project}
        projectName={found.project.name}
        environments={found.project.environments ?? []}
        query={q}
        summary={summary}
        points={series === null ? null : (series.points ?? [])}
        endpoints={endpoints === null ? null : (endpoints.endpoints ?? [])}
        apps={apps?.apps ?? null}
      />
    </AppShell>
  );
}
