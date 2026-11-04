import type { Metadata } from "next";
import { CreateOrg } from "@/components/onboarding/create-org";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Create organization" };

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("create");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext("/onboarding/create");
  const owned = ctx.orgs.filter((o) => o.role === "owner").map((o) => o.slug);
  return <CreateOrg step={step} reached={reached} answers={answers} host={new URL(env().publicUrl).host} owned={owned} />;
}
