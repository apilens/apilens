import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ExploreView } from "@/components/explore/explore";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { getContext, getSession } from "@/lib/auth/server";
import { PAGE_SIZE, apiQuery, bucketFor, exploreUrl, hasLegacy, readExploreUrl } from "@/lib/explore-query";
import { type NamedApp, type RequestRow, type RequestTimeline, type SavedView, identity, isApiError } from "@/lib/identity";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Explore" };

type SearchParams = Record<string, string | string[] | undefined>;

// Explore (#585, revamped after Supabase Unified Logs in #1052): the request log, newest first, read
// here once and then paged and polled by the browser. The whole view is in the URL: the range or
// window, the conditions (`?filter=field:op:value`) and the open request (`?id=`). An older link
// (`?status=4xx&app=…`, from other pages and saved bookmarks) is rewritten to that scheme once,
// here, so every link into Explore keeps working.
export default async function ExplorePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const q = readExploreUrl(sp);
  const later = sp[LATER_PARAM] === LATER_VALUE;
  const next = exploreUrl(project, q);
  if (hasLegacy(sp)) redirect(later ? `${next}${next.includes("?") ? "&" : "?"}${LATER_PARAM}=${LATER_VALUE}` : next);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const session = await getSession();
  const now = Date.now();
  const api = apiQuery(q, now);
  let rows: RequestRow[] | null = null;
  let cursor = "";
  let timeline: RequestTimeline | null = null;
  let views: SavedView[] | null = null;
  let apps: NamedApp[] | null = null;
  // The log, the chart, the saved views (#589) and the project's apps (#975, the App facet and
  // column) are read together; each can fail without the others.
  const [log, chart, saved, appList] = await Promise.allSettled([
    session.call((o) => identity().listRequests(project, { ...api, limit: PAGE_SIZE }, o)),
    session.call((o) => identity().requestTimeline(project, { ...api, bucket: bucketFor(q, now) }, o)),
    session.call((o) => identity().listSavedViews(project, "explore", o)),
    session.call((o) => identity().projectApps(project, o)),
  ]);
  for (const r of [log, chart, saved, appList]) {
    if (r.status === "fulfilled") continue;
    if (isSessionExpired(r.reason)) redirectToRefresh(next);
    if (!isApiError(r.reason)) throw r.reason;
  }
  if (log.status === "fulfilled") {
    rows = log.value.requests ?? [];
    cursor = log.value.next_cursor ?? "";
  }
  if (chart.status === "fulfilled") timeline = chart.value;
  if (saved.status === "fulfilled") views = saved.value.views ?? [];
  if (appList.status === "fulfilled") apps = appList.value.apps ?? [];

  return (
    <AppShell context={context} project={project} view="explore">
      <ExploreView
        project={project}
        environments={found.project.environments ?? []}
        apps={apps}
        query={q}
        rows={rows}
        cursor={cursor}
        timeline={timeline}
        views={views}
        me={context.user.id}
        now={now}
        notice={later ? <SetupReminder project={project} /> : null}
      />
    </AppShell>
  );
}
