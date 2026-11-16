import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EndpointView, type SettingsLoad, type TabLoad } from "@/components/endpoint/endpoint";
import { getContext, getSession } from "@/lib/auth/server";
import { type EndpointRef, type EndpointState, endpointPageHref, parseEndpointQuery, parseEndpointRef } from "@/lib/endpoint-detail";
import { type CallOptions, type EndpointSettings, type ProjectApps, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

type Params = { project: string; method: string; path: string };
type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { method, path } = await params;
  const ep = parseEndpointRef(method, path);
  return { title: ep ? `${ep.method} ${ep.path}` : "Endpoint" };
}

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

/** Only the open tab's read runs: the other tabs read when they are opened. */
async function readTab(project: string, ep: EndpointRef, q: EndpointState, next: string): Promise<TabLoad> {
  const api = identity();
  // `?app=` (#976) reads the endpoint as that app serves it; without it, across all apps.
  const scope = { range: q.range, env: q.env, consumer: q.consumer, ...(q.app ? { app: q.app } : {}) };
  const withStatus = { ...scope, status: q.status };
  switch (q.tab) {
    case "requests":
      return { tab: "requests", data: await read(next, (o) => api.endpointRequests(project, ep.method, ep.path, withStatus, o)) };
    case "errors":
      return { tab: "errors", data: await read(next, (o) => api.endpointErrors(project, ep.method, ep.path, scope, o)) };
    case "latency":
      return { tab: "latency", data: await read(next, (o) => api.endpointLatency(project, ep.method, ep.path, withStatus, o)) };
    case "transfer":
      return { tab: "transfer", data: await read(next, (o) => api.endpointTransfer(project, ep.method, ep.path, withStatus, o)) };
  }
}

/**
 * The project's apps and the app the settings dialog opens on with its settings for this endpoint:
 * the app in scope (`?app=`, #976), else the first. `scoped` says whether that app is the page's
 * whole scope (the filter names it, or the project has only it).
 */
async function readSettings(project: string, ep: EndpointRef, q: EndpointState, next: string): Promise<SettingsLoad> {
  const apps = await read<ProjectApps>(next, (o) => identity().projectApps(project, o));
  if (apps === null) return { apps: null, app: null, settings: null, scoped: false };
  const list = apps.apps ?? [];
  const inScope = list.find((a) => a.id === q.app) ?? null;
  const app = inScope ?? list[0] ?? null;
  const scoped = inScope !== null || (!q.app && list.length === 1);
  if (!app) return { apps: list, app: null, settings: null, scoped: false };
  const settings = await read<EndpointSettings>(next, (o) => identity().getEndpointSettings(project, app.id, ep.method, ep.path, o));
  return { apps: list, app, settings, scoped };
}

// One endpoint (#593): the locked scope (method, path), the filter bar with the app filter (#976)
// and four tabs, each reading its own data only when it is open; the settings dialog edits the
// endpoint's settings in the app it asks for.
export default async function EndpointPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { project, method, path } = await params;
  const ep = parseEndpointRef(method, path);
  if (!ep) notFound();
  const sp = await searchParams;
  const q = parseEndpointQuery(sp);
  const next = endpointPageHref(project, ep, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const [tab, settings] = await Promise.all([readTab(project, ep, q, next), readSettings(project, ep, q, next)]);

  return (
    <AppShell context={context} project={project} view="traffic">
      <EndpointView
        project={project}
        projectName={found.project.name}
        environments={found.project.environments ?? []}
        endpoint={ep}
        query={q}
        tab={tab}
        settings={settings}
        params={sp}
      />
    </AppShell>
  );
}
