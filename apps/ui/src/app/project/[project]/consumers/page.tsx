import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type ConsumersData, ConsumersView } from "@/components/consumers/consumers";
import { ConsumersMenu } from "@/components/consumers/menu";
import { getContext, getSession } from "@/lib/auth/server";
import { pickConsumerSdks } from "@/lib/consumer-setup";
import { CONSUMER_RANGES, type ConsumersQuery, DEFAULT_RANGE, consumersHref, parseConsumersQuery } from "@/lib/consumers";
import {
  type CallOptions,
  type ConsumerGroupsTraffic,
  type ConsumerSortKey,
  type ConsumersList,
  type GroupSortKey,
  identity,
  isApiError,
} from "@/lib/identity";
import { type PageState, type SearchParams, clampPage, pageOffset, parsePage } from "@/lib/pagination";
import { findProject } from "@/lib/scope";
import { withScopeDefaults } from "@/lib/scope-defaults";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Consumers" };

/** One read as the signed-in user: the answer, `null` when the API could not answer, `404` when it says not found. */
async function read<T>(next: string, fn: (o: CallOptions & { accessToken: string }) => Promise<T>): Promise<T | null | 404> {
  const session = await getSession();
  try {
    return await session.call(fn);
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return err.code === "not_found" ? 404 : null;
    throw err;
  }
}

/**
 * Reads one page of a server-paged list. When the page is past the end (the total shrank while the
 * reader was on it, or a hand-edited URL), reads the last page instead, so the reader lands on the
 * new last page rather than an empty one; <Pagination> clamps its own page the same way.
 */
async function readPage<T>(
  page: PageState,
  maxOffset: number,
  fetch: (offset: number) => Promise<T | null | 404>,
  count: (t: T) => { rows: number; total: number },
): Promise<T | null | 404> {
  // An offset the API would refuse is surely past the end: read the first page for the total.
  const offset = pageOffset(page);
  const got = await fetch(offset > maxOffset ? 0 : offset);
  if (got === null || got === 404) return got;
  const { rows, total } = count(got);
  const last = clampPage(page.page, total, page.per);
  if ((rows > 0 && offset <= maxOffset) || total === 0 || last === page.page) return got;
  return fetch(Math.min(maxOffset, pageOffset({ page: last, per: page.per })));
}

/** The largest offset the lists take. */
const MAX_LIST_OFFSET = 100_000;

async function load(project: string, q: ConsumersQuery, page: PageState, next: string): Promise<ConsumersData> {
  const api = identity();
  const env = q.env ? { env: q.env } : {};
  const sort: ConsumerSortKey = q.sort === "consumers" ? "requests" : q.sort;
  // The list feeds the chart and the stats on every tab; its rows are the Consumers tab's table.
  const consumersTab = q.by === "consumers";
  const [list, groups, anonymous, groupFacet, detail] = await Promise.all([
    consumersTab
      ? readPage<ConsumersList>(
          page,
          MAX_LIST_OFFSET,
          (offset) =>
            read(next, (o) =>
              api.listConsumers(project, { range: q.range, ...env, sort, limit: page.per, offset, ...(q.group ? { group: q.group } : {}), ...(q.q ? { search: q.q } : {}) }, o),
            ),
          (l) => ({ rows: (l.consumers ?? []).length, total: l.total }),
        )
      : read(next, (o) => api.listConsumers(project, { range: q.range, ...env, limit: 1 }, o)),
    q.by === "groups"
      ? readPage<ConsumerGroupsTraffic>(
          page,
          MAX_LIST_OFFSET,
          (offset) =>
            read(next, (o) => api.listConsumerGroupTraffic(project, { range: q.range, ...env, sort: q.sort as GroupSortKey, limit: page.per, offset, ...(q.q ? { search: q.q } : {}) }, o)),
          (g) => ({ rows: (g.groups ?? []).length, total: g.total }),
        )
      : Promise.resolve(null),
    // The Anonymous tab's callers, and the stats' anonymous requests on every tab.
    read(next, (o) => api.listAnonymousCallers(project, { range: q.range, ...env, limit: q.by === "anonymous" ? ANONYMOUS_CALLERS : 1 }, o)),
    // The sidebar's Group section: the groups with their users, most users first.
    read(next, (o) => api.listConsumerGroupTraffic(project, { range: q.range, ...env, sort: "consumers", limit: GROUP_FACETS }, o)),
    q.consumer ? read(next, (o) => api.getConsumer(project, q.consumer as string, { range: q.range, ...env, limit: DRAWER_ROWS }, o)) : Promise.resolve(null),
  ]);
  const ok = <T,>(v: T | null | 404): T | null => (v === null || v === 404 ? null : v);
  const l = ok(list);
  const nobody = l !== null && l.summary.consumers === 0 && l.total === 0 && !q.q && !q.group;
  return {
    list: l,
    groups: ok(groups),
    anonymous: ok(anonymous),
    groupFacet: ok(groupFacet)?.groups ?? null,
    detail: !q.consumer ? undefined : detail === 404 ? { kind: "missing" } : detail === null ? { kind: "error" } : { kind: "ok", consumer: detail },
    sdks: nobody ? await loadSdks(project, next) : null,
  };
}

/** The most groups the sidebar lists, and recent requests and errors the drawer shows. */
const GROUP_FACETS = 20;
const DRAWER_ROWS = 5;

/** The most anonymous callers the empty state lists. */
const ANONYMOUS_CALLERS = 10;

/**
 * No user identified in the range (#989): the SDKs the project's apps run (from what each app's SDK
 * reported), which pick the identify snippet's tabs. An app whose report cannot be read is skipped.
 */
async function loadSdks(project: string, next: string) {
  const api = identity();
  const apps = await read(next, (o) => api.projectApps(project, o));
  const listed = apps === null || apps === 404 ? [] : (apps.apps ?? []);
  const reports = await Promise.all(listed.map((app) => read(next, (o) => api.appReports(app.id, o))));
  const frameworks = reports.flatMap((r) => (r === null || r === 404 ? [] : (r.environments ?? []).map((e) => e.framework)));
  return pickConsumerSdks(frameworks);
}

// Consumers (#596): the users of the API, Traffic's frame (sidebar, filter bar, pinned chart, stats
// strip): new vs returning over time, then Consumers (one row per username, its group beside it),
// Groups and Anonymous tabs; a username opens its drawer (requests, errors, top endpoints).
export default async function ConsumersPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const raw = await searchParams;
  const next = consumersHref(project, parseConsumersQuery(raw));
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  // No range in the URL (#993): the range that covers the project's first data.
  const { params: sp } = await withScopeDefaults(raw, {
    environments: found.project.environments ?? [],
    firstAt: async () => {
      const s = await read(next, (o) => identity().ingestStatus(project, o));
      return s === null || s === 404 ? null : s.first_at;
    },
    ranges: CONSUMER_RANGES,
    fallbackRange: DEFAULT_RANGE,
  });
  const q = parseConsumersQuery(sp);
  const page = parsePage(sp);

  const data = await load(project, q, page, next);

  return (
    <AppShell
      context={context}
      project={project}
      view="consumers"
      menu={<ConsumersMenu project={project} query={q} environments={found.project.environments ?? []} groups={data.groupFacet} />}
    >
      <ConsumersView project={project} query={q} params={sp} data={data} now={Date.now()} environments={found.project.environments ?? []} />
    </AppShell>
  );
}
