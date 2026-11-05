import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LoadFailed } from "@/components/alerts/common";
import { RuleEditor } from "@/components/alerts/rule-editor";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { ruleHref } from "@/lib/alerts";
import { findProject } from "@/lib/scope";
import { loadRule } from "../../load";
import { loadEditorData } from "../editor-data";

export const metadata: Metadata = { title: "Alert rule" };

// One alert rule in the editor (#610).
export default async function RulePage({ params }: { params: Promise<{ project: string; id: string }> }) {
  const { project, id } = await params;
  const next = ruleHref(project, id);
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const [rule, data] = await Promise.all([loadRule(project, id, next), loadEditorData(project, found.project.environments ?? [], next)]);
  if (rule === "gone") notFound();
  return (
    <AppShell context={context} project={project} view="incidents">
      {rule === null ? (
        <div className="al">
          <LoadFailed text="We couldn’t load this alert rule just now." href={next} />
        </div>
      ) : (
        <RuleEditor key={rule.updated_at} project={project} projectName={found.project.name} rule={rule} {...data} />
      )}
    </AppShell>
  );
}
