// Access › Activity (`/<project>/access/activity`, #812): the project's audit log, a page at a
// time, filtered by person, action group and date range from the URL.
import { ActivityLoadFailed, ActivityNotAllowed, ActivityView } from "@/components/access/activity";
import type { PersonOption } from "@/components/access/activity-filters";
import { exportFilters, offeredGroups, parseActivityFilters } from "@/lib/audit";
import { auditCaller, loadActivityPage } from "@/lib/audit-load";
import { identity } from "@/lib/identity";
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
  // The Project filter belongs to the organization's audit log; here the project is the page's.
  const { project: _, ...filters } = parseActivityFilters(search);
  const scope = { project };
  const call = await auditCaller(next);
  const [page, access] = await Promise.all([
    loadActivityPage({ scope, catalogue: scope, filters, search, next, limit: ACTIVITY_PAGE }),
    call((o) => identity().projectAccess(project, { limit: PEOPLE_LIMIT }, o)),
  ]);
  if (page === "forbidden") return <ActivityNotAllowed />;
  if (page === null) return <ActivityLoadFailed />;

  const people: PersonOption[] =
    access && access !== "forbidden" ? (access.members ?? []).map((m) => ({ id: m.user_id, name: m.name || m.email })) : [];
  const labels = Object.fromEntries(page.actions.map((a) => [a.action, a.label]));

  return (
    <ActivityView
      exportPath={`/api/projects/${encodeURIComponent(project)}/audit-export`}
      pathname={`/${project}/access/activity`}
      params={search}
      filters={filters}
      people={people}
      groups={offeredGroups(page.actions)}
      labels={labels}
      events={page.events}
      next={page.next}
      retentionDays={page.retentionDays}
      exportable={exportFilters(filters, page.actions) !== null}
      now={Date.now()}
    />
  );
}
