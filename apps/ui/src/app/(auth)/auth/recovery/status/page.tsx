import type { Metadata } from "next";
import { headers } from "next/headers";
import { RecoveryStatusPage } from "@/components/onboarding/recovery";
import { contextFromHeaders } from "@/lib/identity";
import { recoveryView } from "@/lib/recovery";

export const metadata: Metadata = { title: "Account recovery", referrer: "no-referrer" };

/**
 * Linked from the "recovery ready" email (#321): loads the request on the server and counts down
 * to `ready_at`. Opening it changes nothing; confirming is a button.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const view = await recoveryView(token, { context: contextFromHeaders(await headers()) });
  return <RecoveryStatusPage view={view} />;
}
