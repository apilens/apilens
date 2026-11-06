import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { type ConsumersData, ConsumersView, type DetailState } from "@/components/consumers/consumers";
import { getContext, getSession } from "@/lib/auth/server";
import { type ConsumersQuery, consumersHref, errorsOf, parseConsumersQuery } from "@/lib/consumers";
import {
  type CallOptions,
  type ConsumerDetail,
  type ConsumerGroupsTraffic,
  type ConsumerSortKey,
  type ConsumersList,
  type GroupSortKey,
  identity,
  isApiError,
} from "@/lib/identity";
import { type PageState, type SearchParams, clampPage, pageOffset, parsePage } from "@/lib/pagination";
import { findProject } from "@/lib/scope";
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

/** The largest offsets the API takes: the consumer detail's latest requests, and the lists. */
const MAX_DETAIL_OFFSET = 10_000;
const MAX_LIST_OFFSET = 100_000;

async function load(project: string, q: ConsumersQuery, page: PageState, next: string): Promise<ConsumersData> {
  const api = identity();
  if (q.consumer) {
    const id = q.consumer;
    const detail = await readPage<ConsumerDetail>(
      page,
      MAX_DETAIL_OFFSET,
      (offset) => read(next, (o) => api.getConsumer(project, id, { range: q.range, limit: page.per, offset }, o)),
      (d) =>
        q.tab === "errors" ? { rows: (d.recent_errors ?? []).length, total: errorsOf(d.summary) } : { rows: (d.recent_requests ?? []).length, total: d.summary.requests },
    );
    const state: DetailState = detail === 404 ? { kind: "missing" } : detail === null ? { kind: "error" } : { kind: "ok", consumer: detail };
    return { view: "detail", detail: state };
  }
  if (q.by === "groups") {
    const groups = await readPage<ConsumerGroupsTraffic>(
      page,
      MAX_LIST_OFFSET,
      (offset) =>
        read(next, (o) => api.listConsumerGroupTraffic(project, { range: q.range, sort: q.sort as GroupSortKey, limit: page.per, offset, ...(q.q ? { search: q.q } : {}) }, o)),
      (g) => ({ rows: (g.groups ?? []).length, total: g.total }),
    );
    return { view: "groups", groups: groups === 404 ? null : groups };
  }
  const sort: ConsumerSortKey = q.sort === "consumers" ? "requests" : q.sort;
  const list = await readPage<ConsumersList>(
    page,
    MAX_LIST_OFFSET,
    (offset) =>
      read(next, (o) =>
        api.listConsumers(project, { range: q.range, sort, limit: page.per, offset, ...(q.group ? { group: q.group } : {}), ...(q.q ? { search: q.q } : {}) }, o),
      ),
    (l) => ({ rows: (l.consumers ?? []).length, total: l.total }),
  );
  return { view: "consumers", list: list === 404 ? null : list };
}

// Consumers (#596): the users of the API, new vs returning, the paged users table with sparklines
// (or the SDK groups roll-up), and one user's requests, errors and top endpoints.
export default async function ConsumersPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const q = parseConsumersQuery(sp);
  const page = parsePage(sp);
  const next = consumersHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const data = await load(project, q, page, next);

  return (
    <AppShell context={context} project={project} view="consumers">
      <ConsumersView project={project} projectName={found.project.name} query={q} params={sp} data={data} now={Date.now()} />
    </AppShell>
  );
}
