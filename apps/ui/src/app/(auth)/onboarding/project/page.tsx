import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CreateProject } from "@/components/onboarding/create-project";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { projectOrg } from "@/lib/project-create";

export const metadata: Metadata = { title: "Create project" };

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("project");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext("/onboarding/project");
  const org = projectOrg(ctx, answers.org_slug);
  // No organization to put a project in yet: name one first.
  if (!org) redirect("/onboarding/create");
  return (
    <CreateProject
      step={step}
      reached={reached}
      answers={answers}
      host={new URL(env().publicUrl).host}
      org={{ slug: org.slug, name: org.name }}
      existing={org.projects.map((p) => ({ slug: p.slug, name: p.name, environments: p.environments }))}
    />
  );
}
