import type { Metadata } from "next";
import { TwoFactor } from "@/components/onboarding/two-factor";

export const metadata: Metadata = { title: "Two-factor authentication", referrer: "no-referrer" };

/**
 * The second step of a sign-in that answered `2fa_required` (#320). The pending sign-in lives in
 * the httpOnly pre-auth cookie, which only `/api/auth/2fa/exchange` can read. `next` is read here,
 * on the server, so the form is in the first paint (before, or without, JavaScript).
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <TwoFactor next={typeof next === "string" ? next : null} />;
}
