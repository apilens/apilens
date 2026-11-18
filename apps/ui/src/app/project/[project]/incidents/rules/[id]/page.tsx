import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/states";
import { RuleEditor } from "@/components/alerts/rule-editor";
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
  return rule === null ? (
    <div className="page al">
      <ErrorState text="We couldn’t load this alert rule just now." href={next} />
    </div>
  ) : (
    <RuleEditor key={rule.updated_at} project={project} projectName={found.project.name} rule={rule} {...data} />
  );
}
