import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Instrument } from "@/components/onboarding/instrument";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { POSTURE_PARAM, postureOf } from "@/lib/install";

export const metadata: Metadata = { title: "Instrument" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { step, reached, answers } = await requireOnboardingStep("instrument");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext("/onboarding/instrument");
  const project = ctx.orgs.flatMap((o) => o.projects).find((p) => p.slug === answers.project_slug);
  // No project to instrument yet: create one first.
  if (!project) redirect("/onboarding/project");
  // Back from the install step: start on the posture picked before.
  const posture = postureOf((await searchParams)[POSTURE_PARAM]);
  return <Instrument step={step} reached={reached} answers={answers} project={project.name} posture={posture} />;
}
