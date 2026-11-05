import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RuleEditor } from "@/components/alerts/rule-editor";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { newRuleHref } from "@/lib/alerts";
import { findProject } from "@/lib/scope";
import { loadEditorData } from "../editor-data";

export const metadata: Metadata = { title: "New alert rule" };

// A new alert rule (#610).
export default async function NewRulePage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const next = newRuleHref(project);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const data = await loadEditorData(project, found.project.environments ?? [], next);
  return (
    <AppShell context={context} project={project} view="incidents">
      <RuleEditor project={project} projectName={found.project.name} rule={null} {...data} />
    </AppShell>
  );
}
