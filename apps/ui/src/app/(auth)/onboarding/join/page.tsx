import type { Metadata } from "next";
import { JoinOrg } from "@/components/onboarding/join-org";
import { requireOnboardingStep } from "@/lib/auth/onboarding";

export const metadata: Metadata = { title: "Join your team" };

export default async function Page() {
  const { step, reached } = await requireOnboardingStep("join");
  return <JoinOrg step={step} reached={reached} />;
}
