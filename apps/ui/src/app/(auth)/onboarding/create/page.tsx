import type { Metadata } from "next";
import { CreateOrg } from "@/components/onboarding/create-org";
import { requireOnboardingStep } from "@/lib/auth/onboarding";

export const metadata: Metadata = { title: "Create organization" };

export default async function Page() {
  const { step, reached } = await requireOnboardingStep("create");
  return <CreateOrg step={step} reached={reached} />;
}
