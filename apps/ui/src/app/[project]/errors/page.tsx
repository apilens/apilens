import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type DetailLoad, ErrorsView, type TabLoad } from "@/components/errors/errors";
import { getContext, getSession } from "@/lib/auth/server";
import { type ErrorsState, errorsHref, parseErrorsQuery } from "@/lib/errors";
import { type CallOptions, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Errors" };

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

/** Only the open tab reads its data. */
async function readTab(project: string, q: ErrorsState, next: string): Promise<TabLoad> {
  const scope = { range: q.range, env: q.env };
  if (q.tab === "issues") {
    const list = await read(next, (o) => identity().listErrors(project, scope, o));
    return { tab: "issues", data: list === null ? null : (list.errors ?? []) };
  }
  return { tab: "status", data: await read(next, (o) => identity().errorStatuses(project, scope, o)) };
}

// Errors (#594): 4xx and 5xx over time and the error status codes by count; one status code's
// detail opens in a modal (`?code=`) with "mark as expected"; the endpoint × status list is the
// Issues tab. Scoped by the range and environment in the URL.
export default async function ErrorsPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const q = parseErrorsQuery(await searchParams);
  const next = errorsHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const code = q.tab === "status" ? q.code : null;
  const [tab, detail] = await Promise.all([
    readTab(project, q, next),
    code === null ? Promise.resolve(undefined) : read(next, (o) => identity().errorStatus(project, code, { range: q.range, env: q.env }, o)),
  ]);
  const detailLoad: DetailLoad | undefined = code === null ? undefined : { code, data: detail ?? null };

  return (
    <AppShell context={context} project={project} view="errors">
      <ErrorsView project={project} projectName={found.project.name} environments={found.project.environments ?? []} query={q} tab={tab} detail={detailLoad} />
    </AppShell>
  );
}
