import type { Metadata } from "next";
import { JoinOrg } from "@/components/onboarding/join-org";

export const metadata: Metadata = { title: "Join your team" };

export default function Page() {
  return <JoinOrg />;
}
