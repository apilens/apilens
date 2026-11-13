// Access › Activity (`/<project>/access/activity`, #812): the project's audit log, a page at a
// time, filtered by person, action group and date range from the URL.
import { ActivityLoadFailed, ActivityNotAllowed, ActivityView } from "@/components/access/activity";
import type { PersonOption } from "@/components/access/activity-filters";
import { getSession } from "@/lib/auth/server";
import { apiFilters, decodeBound, encodeBound, exportFilters, offeredGroups, pageCut, parseActivityFilters } from "@/lib/audit";
import { type AuditAction, identity, isApiError } from "@/lib/identity";
import { parseTrail, trailCursor } from "@/lib/pagination";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "../settings/sections/types";

/** Events a page shows. */
export const ACTIVITY_PAGE = 25;

/** The people offered in the Person filter: the first page of the project's access list. */
const PEOPLE_LIMIT = 200;

/**
 * Loads and renders the tab: the action catalogue, the people with access (for the Person
 * filter) and one page of events. An API that answers 403 shows the not-allowed state; any other
 * failure the error state.
 */
export async function ActivityTab({ project, search, next }: SectionContext) {
  const session = await getSession();
  const filters = parseActivityFilters(search);
  const bound = decodeBound(trailCursor(parseTrail(search)));
  const call = async <T,>(fn: Parameters<typeof session.call<T>>[0]): Promise<T | "forbidden" | null> => {
    try {
      return await session.call(fn);
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return err.status === 403 || err.status === 404 ? "forbidden" : null;
      throw err;
    }
  };

  const scope = { project };
  const [catalogue, access] = await Promise.all([
    call((o) => identity().auditActions(scope, o)),
    call((o) => identity().projectAccess(project, { limit: PEOPLE_LIMIT }, o)),
  ]);
  if (catalogue === "forbidden") return <ActivityNotAllowed />;
  if (catalogue === null) return <ActivityLoadFailed />;
  const actions: AuditAction[] = catalogue.actions ?? [];

  const queries = apiFilters(filters, actions);
  // One more than a page each: an answer with more may hold further events at its oldest time,
  // which pageCut leaves for the next page.
  const answers = await Promise.all(queries.map((f) => call((o) => identity().listAuditEvents(scope, { ...f, ...(bound ? { to: bound } : {}), limit: ACTIVITY_PAGE + 1 }, o))));
  if (answers.includes("forbidden")) return <ActivityNotAllowed />;
  if (answers.includes(null)) return <ActivityLoadFailed />;
  const pages = answers as Exclude<(typeof answers)[number], "forbidden" | null>[];
  const { events, next: nextBound } = pageCut(
    pages.map((a) => ({ events: a.events ?? [], more: a.next_cursor !== "" })),
    ACTIVITY_PAGE,
  );
  // A group none of whose actions is offered asks nothing, and so learns no retention.
  const retentionDays = pages[0]?.retention_days ?? null;

  const people: PersonOption[] =
    access && access !== "forbidden" ? (access.members ?? []).map((m) => ({ id: m.user_id, name: m.name || m.email })) : [];
  const labels = Object.fromEntries(actions.map((a) => [a.action, a.label]));

  return (
    <ActivityView
      project={project}
      pathname={`/${project}/access/activity`}
      params={search}
      filters={filters}
      people={people}
      groups={offeredGroups(actions)}
      labels={labels}
      events={events}
      next={nextBound ? encodeBound(nextBound) : null}
      retentionDays={retentionDays}
      exportable={exportFilters(filters, actions) !== null}
      now={Date.now()}
    />
  );
}
