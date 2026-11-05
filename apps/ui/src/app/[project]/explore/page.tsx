import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ExploreView } from "@/components/explore/explore";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { getContext, getSession } from "@/lib/auth/server";
import { LOG_LIMIT, exploreHref, parseExploreQuery } from "@/lib/explore";
import { filterQuery } from "@/lib/explore-filters";
import { chartWindow, logWindow } from "@/lib/explore-timeline";
import { type RequestRow, type RequestTimeline, identity, isApiError } from "@/lib/identity";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Explore" };

type SearchParams = Record<string, string | string[] | undefined>;

// Explore (#585): the request log, newest first, read here once and then polled by the browser.
// The filters (#586) come from the URL, so a deep link reproduces the filtered view; so do the
// timeline's zoom and jump point (#587).
export default async function ExplorePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const q = parseExploreQuery(sp);
  const next = exploreHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const session = await getSession();
  let rows: RequestRow[] | null = null;
  let timeline: RequestTimeline | null = null;
  // The log and the timeline (#587) are read together; either can fail without the other.
  const [log, chart] = await Promise.allSettled([
    session.call((o) => identity().listRequests(project, { range: q.range, ...logWindow(q), limit: LOG_LIMIT, ...filterQuery(q.filters) }, o)),
    session.call((o) => identity().requestTimeline(project, { range: q.range, ...chartWindow(q), ...filterQuery(q.filters) }, o)),
  ]);
  for (const r of [log, chart]) {
    if (r.status === "fulfilled") continue;
    if (isSessionExpired(r.reason)) redirectToRefresh(next);
    if (!isApiError(r.reason)) throw r.reason;
  }
  if (log.status === "fulfilled") rows = log.value.requests ?? [];
  if (chart.status === "fulfilled") timeline = chart.value;

  return (
    <AppShell context={context} project={project} view="explore">
      {/* "I'll do this later" on the onboarding install step (#333) can land here as the home view. */}
      {sp[LATER_PARAM] === LATER_VALUE ? <SetupReminder project={project} /> : null}
      <ExploreView
        project={project}
        projectName={found.project.name}
        environments={found.project.environments ?? []}
        query={q}
        rows={rows}
        timeline={timeline}
        now={Date.now()}
      />
    </AppShell>
  );
}
