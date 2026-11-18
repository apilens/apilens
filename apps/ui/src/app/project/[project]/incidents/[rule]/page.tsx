import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/states";
import { IncidentTimeline } from "@/components/alerts/timeline";
import { getContext } from "@/lib/auth/server";
import { EVENTS_PAGE, incidentHref } from "@/lib/alerts";
import { type SearchParams, parseTrail, trailCursor } from "@/lib/pagination";
import { incidentLinks } from "@/lib/incident-links";
import { chartRange, hasSeries } from "@/lib/incident-metric";
import { findProject } from "@/lib/scope";
import { resolveTimeZone } from "@/lib/time-zone";
import { appNames, load, loadApps, loadRule } from "../load";

export const metadata: Metadata = { title: "Incidents" };

// One alert rule's incidents as a timeline (#610), a page of them at a time: `?cursor=` is the
// trail of the API's cursors walked to reach the page (lib/pagination), empty on the newest page.
export default async function IncidentPage({ params, searchParams }: { params: Promise<{ project: string; rule: string }>; searchParams: Promise<SearchParams> }) {
  const { project, rule: id } = await params;
  const sp = await searchParams;
  const cursor = trailCursor(parseTrail(sp));
  const next = incidentHref(project, id);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const [rule, events, { apps }] = await Promise.all([
    loadRule(project, id, next),
    load(next, (api, o) => api.listAlertEvents(project, { rule_id: id, limit: EVENTS_PAGE, ...(cursor ? { cursor } : {}) }, o)),
    loadApps(project, next),
  ]);
  if (rule === "gone") notFound();
  // The rule's metric over its app and environment (#980): 6 h, or 24 h for an older incident.
  const now = Date.now();
  const range = chartRange(events?.events?.[0]?.started_at, now);
  const series =
    rule && hasSeries(rule.metric)
      ? await load(next, (api, o) => api.trafficTimeseries(project, { range, app: rule.app_id, env: rule.environment }, o))
      : null;
  return rule === null ? (
    <div className="page al">
      <ErrorState text="We couldn’t load this alert rule just now." href={next} />
    </div>
  ) : (
    <IncidentTimeline
      project={project}
      projectName={found.project.name}
      rule={rule}
      app={appNames(apps)[rule.app_id]}
      events={events ? (events.events ?? []) : null}
      nextCursor={events?.next_cursor ?? null}
      params={sp}
      now={now}
      tz={resolveTimeZone(context.user.preferences)}
      series={series}
      range={range}
      links={incidentLinks(project, rule, apps, events?.events?.[0]?.started_at, now)}
    />
  );
}
