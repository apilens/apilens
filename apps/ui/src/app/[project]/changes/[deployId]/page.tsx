import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type DeployLoad, DeployView } from "@/components/changes/deploy";
import { getContext, getSession } from "@/lib/auth/server";
import { deployHref } from "@/lib/changes";
import { type CallOptions, identity, isApiError } from "@/lib/identity";
import { type SearchParams, pageHref } from "@/lib/pagination";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Deploy" };

/** A deploy id as the API takes it: up to 16 lowercase hex digits. */
const DEPLOY_ID = /^[0-9a-f]{1,16}$/;

type Read<T> = { ok: true; value: T } | { ok: false; status: number };

/** One read as the signed-in user: the answer, or the API's status when it could not answer. */
async function read<T>(next: string, fn: (o: CallOptions & { accessToken: string }) => Promise<T>): Promise<Read<T>> {
  const session = await getSession();
  try {
    return { ok: true, value: await session.call(fn) };
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return { ok: false, status: err.status };
    throw err;
  }
}

// One deploy (`/<project>/changes/<id>`): before/after verdict, the minutes around it, what changed
// per endpoint, new errors and affected consumers, and the previous/next deploy of the same app.
// `?page=&per=` pages the endpoint table.
export default async function DeployPage({ params, searchParams }: { params: Promise<{ project: string; deployId: string }>; searchParams: Promise<SearchParams> }) {
  const { project, deployId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(deployId).toLowerCase();
  const next = pageHref(deployHref(project, id), sp, {});
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  let load: DeployLoad = { state: "not-found" };
  let comparison = null;
  let apps = null;
  if (DEPLOY_ID.test(id)) {
    const [d, c, a] = await Promise.all([
      read(next, (o) => identity().getDeploy(project, id, o)),
      read(next, (o) => identity().deployComparison(project, id, o)),
      read(next, (o) => identity().projectApps(project, o)),
    ]);
    load = d.ok ? { state: "ok", detail: d.value } : d.status === 404 || d.status === 422 ? { state: "not-found" } : { state: "error" };
    comparison = c.ok ? c.value : null;
    apps = a.ok ? (a.value.apps ?? []) : null;
  }

  return (
    <AppShell context={context} project={project} view="changes">
      <DeployView project={project} projectName={found.project.name} id={id} load={load} comparison={comparison} apps={apps} params={sp} now={Date.now()} />
    </AppShell>
  );
}
