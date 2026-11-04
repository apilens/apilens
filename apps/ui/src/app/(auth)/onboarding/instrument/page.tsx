import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Instrument } from "@/components/onboarding/instrument";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Instrument" };

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("instrument");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext("/onboarding/instrument");
  const project = ctx.orgs.flatMap((o) => o.projects).find((p) => p.slug === answers.project_slug);
  // No project to instrument yet: create one first.
  if (!project) redirect("/onboarding/project");
  return <Instrument step={step} reached={reached} answers={answers} project={project.name} />;
}
