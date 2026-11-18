import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type ChangesLoad, ChangesView } from "@/components/changes/changes";
import { getContext, getSession } from "@/lib/auth/server";
import { CHANGES_PAGE_SIZES, CHANGES_RANGE, parseChangesFilter } from "@/lib/changes";
import { type CallOptions, identity, isApiError } from "@/lib/identity";
import { type ReleaseSdk, pickReleaseSdks } from "@/lib/release-setup";
import { type SearchParams, clampPage, pageHref, pageOffset, parsePage } from "@/lib/pagination";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import { projectHref } from "@/lib/routes";

export const metadata: Metadata = { title: "Deploys" };

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

// Changes (#597): deploys with their before/after error rate and p95, filtered by app and
// environment and paged (`?app=&env=&page=&per=`), each row opening the deploy's page.
export default async function ChangesPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const pathname = projectHref(project, "deploys");
  const next = pageHref(pathname, sp, {});
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const filter = parseChangesFilter(sp);
  const options = { sizes: CHANGES_PAGE_SIZES };
  const state = parsePage(sp, options);
  const [res, apps, repo] = await Promise.all([
    read(next, (o) =>
      identity().deployChanges(project, { range: CHANGES_RANGE, limit: state.per, offset: pageOffset(state), app: filter.app, env: filter.env }, o),
    ),
    read(next, (o) => identity().projectApps(project, o)),
    // The repository link (Settings › Integrations) turns commit ids into links; without it they stay text.
    read(next, (o) => identity().getProject(project, o)),
  ]);
  const load: ChangesLoad | null = res === null ? null : { deploys: res.deploys ?? [], total: res.total ?? 0 };
  // A page past the last one (a hand-edited URL, or deploys aged out of the 7 days): go to the last.
  if (load && load.deploys.length === 0 && load.total > 0 && state.page > 1) {
    redirect(pageHref(pathname, sp, { page: clampPage(state.page, load.total, state.per) }, options));
  }

  // No deploys at all (#997): the empty state's snippet tabs follow the SDKs the apps reported.
  const sdks: ReleaseSdk[] =
    load && load.total === 0 && filter.app === "" && filter.env === "" ? await releaseSdks(next, apps?.apps ?? []) : [];

  return (
    <AppShell context={context} project={project} view="deploys">
      <ChangesView
        project={project}
        projectName={found.project.name}
        load={load}
        now={Date.now()}
        filter={filter}
        params={sp}
        apps={apps?.apps ?? (apps === null ? null : [])}
        environments={found.project.environments ?? []}
        commitUrlTemplate={repo?.commit_url_template ?? null}
        sdks={sdks}
      />
    </AppShell>
  );
}

/** The SDKs `apps` run, from what each app's SDK reported; an app whose report cannot be read is skipped. */
async function releaseSdks(next: string, apps: readonly { id: string }[]): Promise<ReleaseSdk[]> {
  const reports = await Promise.all(apps.map((app) => read(next, (o) => identity().appReports(app.id, o))));
  return pickReleaseSdks(reports.flatMap((r) => (r?.environments ?? []).map((e) => e.framework)));
}
