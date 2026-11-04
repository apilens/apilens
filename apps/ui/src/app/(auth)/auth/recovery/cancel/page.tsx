import type { Metadata } from "next";
import { headers } from "next/headers";
import { RecoveryCancelPage } from "@/components/onboarding/recovery";
import { contextFromHeaders } from "@/lib/identity";
import { recoveryView } from "@/lib/recovery";

export const metadata: Metadata = { title: "Cancel account recovery", referrer: "no-referrer" };

/**
 * Linked from the "recovery requested" alert (#321). Opening it changes nothing (mail scanners
 * open links); cancelling is a button.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const view = await recoveryView(token, { context: contextFromHeaders(await headers()) });
  return <RecoveryCancelPage view={view} />;
}
