import type { Metadata } from "next";
import { About } from "@/components/onboarding/about";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { invitedOrg } from "@/lib/invitations";

export const metadata: Metadata = { title: "Your home screen" };

export default async function Page() {
  const { step, reached } = await requireOnboardingStep("about");
  // Invited users (#337) skip the organization and project steps: Continue opens their project.
  const invited = invitedOrg(await getContext("/onboarding/about"));
  return <About step={step} reached={reached} invitedOrg={invited?.name} />;
}
