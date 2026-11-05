import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ExploreView } from "@/components/explore/explore";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { getContext, getSession } from "@/lib/auth/server";
import { LOG_LIMIT, exploreHref, parseExploreQuery } from "@/lib/explore";
import { filterQuery } from "@/lib/explore-filters";
import { type RequestRow, identity, isApiError } from "@/lib/identity";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Explore" };

type SearchParams = Record<string, string | string[] | undefined>;

// Explore (#585): the request log, newest first, read here once and then polled by the browser.
// The filters (#586) come from the URL, so a deep link reproduces the filtered view.
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
  try {
    const page = await session.call((o) => identity().listRequests(project, { range: q.range, limit: LOG_LIMIT, ...filterQuery(q.filters) }, o));
    rows = page.requests ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (!isApiError(err)) throw err;
  }

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
        now={Date.now()}
      />
    </AppShell>
  );
}
