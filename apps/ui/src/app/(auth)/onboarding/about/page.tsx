import type { Metadata } from "next";
import { About } from "@/components/onboarding/about";

export const metadata: Metadata = { title: "Your home screen" };

export default function Page() {
  return <About />;
}
