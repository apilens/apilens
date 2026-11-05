import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/alerts/common";
import { IncidentTimeline } from "@/components/alerts/timeline";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { incidentHref } from "@/lib/alerts";
import { findProject } from "@/lib/scope";
import { appNames, load, loadApps, loadRule } from "../load";

export const metadata: Metadata = { title: "Incidents" };

/** How many of the rule's latest events the timeline shows. */
const EVENTS_LIMIT = 50;

// One alert rule's incidents as a timeline (#610).
export default async function IncidentPage({ params }: { params: Promise<{ project: string; rule: string }> }) {
  const { project, rule: id } = await params;
  const next = incidentHref(project, id);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const [rule, events, { apps }] = await Promise.all([
    loadRule(project, id, next),
    load(next, (api, o) => api.listAlertEvents(project, { rule_id: id, limit: EVENTS_LIMIT }, o)),
    loadApps(project, next),
  ]);
  if (rule === "gone") notFound();
  return (
    <AppShell context={context} project={project} view="incidents">
      {rule === null ? (
        <div className="al">
          <LoadFailed text="We couldn’t load this alert rule just now." href={next} />
        </div>
      ) : (
        <IncidentTimeline
          project={project}
          projectName={found.project.name}
          rule={rule}
          app={appNames(apps)[rule.app_id]}
          events={events ? (events.events ?? []) : null}
          more={Boolean(events?.next_cursor)}
          now={Date.now()}
        />
      )}
    </AppShell>
  );
}
