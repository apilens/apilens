import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Install } from "@/components/onboarding/install";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext, getSession } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { type ApiKey, identity, isApiError } from "@/lib/identity";
import { appIdFor, savedKeyState } from "@/lib/install";
import { effectiveMethod, savedInstrument } from "@/lib/instrument";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Install" };

const PATH = "/onboarding/install";

/** `GET /projects/{slug}/api-keys`, or null when the API could not answer. */
async function loadKeys(project: string): Promise<ApiKey[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listApiKeys(project, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(PATH);
    if (isApiError(err)) return null;
    throw err;
  }
}

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("install");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext(PATH);
  const project = ctx.orgs.flatMap((o) => o.projects).find((p) => p.slug === answers.project_slug);
  // No project to install into yet: create one first.
  if (!project) redirect("/onboarding/project");
  const choice = savedInstrument(answers);
  const method = effectiveMethod(choice);
  // Nothing picked to install yet: pick it first.
  if (!choice.language || !method) redirect("/onboarding/instrument");
  // Only the saved key's id is known here; the raw key was shown once, when it was created.
  const saved = savedKeyState(answers.api_key_id, answers.api_key_id ? await loadKeys(project.slug) : []);
  return (
    <Install
      step={step}
      reached={reached}
      project={{ slug: project.slug, name: project.name }}
      language={choice.language}
      method={method}
      appId={appIdFor(project.slug)}
      ingestUrl={env().publicIngestUrl}
      saved={saved}
    />
  );
}
