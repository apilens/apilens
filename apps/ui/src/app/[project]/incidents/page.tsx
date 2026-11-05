import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IncidentsView } from "@/components/alerts/incidents";
import { AppShell } from "@/components/app-shell";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { getContext } from "@/lib/auth/server";
import { incidentsHref, incidentsRange } from "@/lib/alerts";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";
import { appNames, load, loadApps } from "./load";

export const metadata: Metadata = { title: "Incidents" };

type SearchParams = Record<string, string | string[] | undefined>;

// Incidents (#610), the project's home view: the incidents feed of the alerts API (#609).
export default async function IncidentsPage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<SearchParams> }) {
  const { project } = await params;
  const sp = await searchParams;
  const range = incidentsRange(sp.range);
  const next = incidentsHref(project, range);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const [feed, { apps }] = await Promise.all([load(next, (api, o) => api.incidents(project, { range }, o)), loadApps(project, next)]);
  return (
    <AppShell context={context} project={project} view="incidents">
      <IncidentsView
        project={project}
        projectName={found.project.name}
        range={range}
        incidents={feed ? (feed.incidents ?? []) : null}
        apps={appNames(apps)}
        now={Date.now()}
        // "I'll do this later" on the onboarding install step (#333) opens the project here with a reminder.
        notice={sp[LATER_PARAM] === LATER_VALUE ? <SetupReminder project={project} /> : null}
      />
    </AppShell>
  );
}
