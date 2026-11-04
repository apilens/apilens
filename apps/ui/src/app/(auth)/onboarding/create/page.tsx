import type { Metadata } from "next";
import { CreateOrg } from "@/components/onboarding/create-org";

export const metadata: Metadata = { title: "Create organization" };

export default function Page() {
  return <CreateOrg />;
}
