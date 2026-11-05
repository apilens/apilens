import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RulesView } from "@/components/alerts/rules";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { rulesHref } from "@/lib/alerts";
import { findProject } from "@/lib/scope";
import { appNames, load, loadApps } from "../load";

export const metadata: Metadata = { title: "Alert rules" };

// Alert rules (#610): the project's rules with their latest evaluation.
export default async function RulesPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const next = rulesHref(project);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const [rules, channels, { apps }] = await Promise.all([
    load(next, (api, o) => api.listAlertRules(project, o)),
    load(next, (api, o) => api.listChannels(project, o)),
    loadApps(project, next),
  ]);
  return (
    <AppShell context={context} project={project} view="incidents">
      <RulesView
        project={project}
        projectName={found.project.name}
        rules={rules ? (rules.rules ?? []) : null}
        apps={appNames(apps)}
        channels={Object.fromEntries((channels?.channels ?? []).map((c) => [c.id, c.name]))}
      />
    </AppShell>
  );
}
