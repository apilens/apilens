import type { Metadata } from "next";
import { Suspense } from "react";
import { Verify } from "@/components/onboarding/verify";

export const metadata: Metadata = { title: "Check your inbox" };

export default function Page() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
