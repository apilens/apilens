import type { ReactNode } from "react";
import { OnboardingProgress } from "@/components/onboarding/progress";

// Shared by every onboarding screen, so the "couldn't save" toast (#327) outlives the screen
// whose Continue started the save. The session and step checks stay in each page (#326).
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <OnboardingProgress>{children}</OnboardingProgress>;
}
