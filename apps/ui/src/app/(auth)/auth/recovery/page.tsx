import type { Metadata } from "next";
import { RecoveryRequest } from "@/components/onboarding/recovery";
import { linkEmail } from "@/lib/magic-link";

export const metadata: Metadata = { title: "Lost your device?" };

/** "Lost your device?" from the two-factor step (#321); `?email=` prefills the address. */
export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string | string[] }> }) {
  const { email } = await searchParams;
  return <RecoveryRequest email={linkEmail(email)} />;
}
