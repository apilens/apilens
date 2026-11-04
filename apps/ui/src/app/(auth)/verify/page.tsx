import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LinkProblem, SignedInAs } from "@/components/onboarding/link-landing";
import { Verify } from "@/components/onboarding/verify";
import { identity } from "@/lib/identity";
import { type VerifyQuery, verifyLanding } from "@/lib/magic-link";
import { componentSession } from "@/lib/server-session";

export const metadata: Metadata = { title: "Check your inbox", referrer: "no-referrer" };

/**
 * The code entry page (#315) and the magic-link landing (#316): with `?token=` the link is
 * exchanged on the server (`lib/magic-link.ts`), never in the browser.
 */
export default async function Page({ searchParams }: { searchParams: Promise<VerifyQuery> }) {
  const query = await searchParams;
  const landing = query.token || query.link ? await land(query) : ({ kind: "code" } as const);

  switch (landing.kind) {
    case "exchange":
    case "continue":
      redirect(landing.location);
    case "signed_in_as":
      return <SignedInAs current={landing.current} linkEmail={landing.linkEmail} continueTo={landing.continueTo} switchTo={landing.switchTo} />;
    case "problem":
      return <LinkProblem problem={landing.problem} email={landing.email} next={landing.next} />;
    default:
      return (
        <Suspense>
          <Verify />
        </Suspense>
      );
  }
}

async function land(query: VerifyQuery) {
  const session = await componentSession();
  return verifyLanding(query, {
    session: session.payload,
    me: () => session.call((o) => identity().me(o)),
  });
}
