import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { CreateOrg } from "@/components/onboarding/create-org";
import { getJoinableOrgs, requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Create organization" };

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("create");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext("/onboarding/create");
  const owned = ctx.orgs.filter((o) => o.role === "owner").map((o) => o.slug);
  // The join step is skipped without organizations to join (#329), so Back passes it too. If
  // the list cannot be read, Back stays on the join step (which then reports the failure).
  let back = "/onboarding/join";
  try {
    if ((await getJoinableOrgs("/onboarding/create")).length === 0) back = "/onboarding/about";
  } catch (err) {
    unstable_rethrow(err);
  }
  return <CreateOrg step={step} reached={reached} answers={answers} host={new URL(env().publicUrl).host} owned={owned} back={back} />;
}
