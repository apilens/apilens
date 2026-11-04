import type { Metadata } from "next";
import { Suspense } from "react";
import { TwoFactor } from "@/components/onboarding/two-factor";

export const metadata: Metadata = { title: "Two-factor authentication", referrer: "no-referrer" };

/**
 * The second step of a sign-in that answered `2fa_required` (#320). The pending sign-in lives in
 * the httpOnly pre-auth cookie, which only `/api/auth/2fa/exchange` can read.
 */
export default function Page() {
  return (
    <Suspense>
      <TwoFactor />
    </Suspense>
  );
}
