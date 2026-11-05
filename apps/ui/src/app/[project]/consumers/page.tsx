import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConsumersView, type DetailState } from "@/components/consumers/consumers";
import { getContext, getSession } from "@/lib/auth/server";
import { GROUPS_LIMIT, LIST_LIMIT, consumersHref, parseConsumersQuery } from "@/lib/consumers";
import { type CallOptions, type ConsumerDetail, type ConsumerGroup, type ConsumersList, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Consumers" };

type SearchParams = Record<string, string | string[] | undefined>;

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

// Consumers (#596): unique consumers new vs returning, the consumer table with sparklines (or the
// groups roll-up), one consumer's requests and errors, and consumer group management.
export default async function ConsumersPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const q = parseConsumersQuery(await searchParams);
  const next = consumersHref(project, q);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();

  const [list, groups, detail] = await Promise.all([
    read<ConsumersList>(next, (o) =>
      identity().listConsumers(project, { range: q.range, limit: q.by === "groups" ? GROUPS_LIMIT : LIST_LIMIT, ...(q.group && q.by !== "groups" ? { group: q.group } : {}) }, o),
    ),
    read<{ groups: ConsumerGroup[] | null }>(next, (o) => identity().listConsumerGroups(project, o)),
    q.consumer ? read<ConsumerDetail>(next, (o) => identity().getConsumer(project, q.consumer as string, { range: q.range }, o)) : Promise.resolve(undefined),
  ]);

  const detailState: DetailState | undefined =
    detail === undefined ? undefined : detail === 404 ? { kind: "missing" } : detail === null ? { kind: "error" } : { kind: "ok", consumer: detail };

  return (
    <AppShell context={context} project={project} view="consumers">
      <ConsumersView
        project={project}
        projectName={found.project.name}
        query={q}
        list={list === 404 ? null : list}
        groups={groups === null || groups === 404 ? null : (groups.groups ?? [])}
        detail={detailState}
        now={Date.now()}
      />
    </AppShell>
  );
}
