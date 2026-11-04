import type { Metadata } from "next";
import { About } from "@/components/onboarding/about";
import { requireOnboardingStep } from "@/lib/auth/onboarding";

export const metadata: Metadata = { title: "Your home screen" };

export default async function Page() {
  const { step, reached } = await requireOnboardingStep("about");
  return <About step={step} reached={reached} />;
}
