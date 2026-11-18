import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Waiting } from "@/components/onboarding/waiting";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { appIdFor } from "@/lib/install";
import { savedInstrument } from "@/lib/instrument";
import { resolveTimeZone } from "@/lib/time-zone";

export const metadata: Metadata = { title: "Waiting for your first request" };

const PATH = "/onboarding/waiting";

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("waiting");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext(PATH);
  const project = ctx.orgs.flatMap((o) => o.projects).find((p) => p.slug === answers.project_slug);
  // No project to wait on yet: create one first.
  if (!project) redirect("/onboarding/project");
  // No language picked yet: pick one first.
  if (!savedInstrument(answers).language) redirect("/onboarding/instrument");
  return (
    <Waiting
      step={step}
      reached={reached}
      project={{ slug: project.slug, name: project.name }}
      appId={appIdFor(project.slug)}
      ingestUrl={env().publicIngestUrl}
      tz={resolveTimeZone(ctx.user.preferences)}
    />
  );
}
