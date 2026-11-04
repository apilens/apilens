import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JoinOrg } from "@/components/onboarding/join-org";
import { getJoinableOrgs, requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { CREATE_ORG_PATH, emailDomain } from "@/lib/join-org";

export const metadata: Metadata = { title: "Join your team" };

const PATH = "/onboarding/join";

// "Join your team" (#329): the organizations whose allowed domains hold the user's verified email
// domain. With none, the step is skipped: the user creates their organization instead.
export default async function Page() {
  const { step, reached } = await requireOnboardingStep("join");
  const orgs = await getJoinableOrgs(PATH);
  if (orgs.length === 0) redirect(CREATE_ORG_PATH);
  const ctx = await getContext(PATH);
  return <JoinOrg step={step} reached={reached} orgs={orgs} domain={emailDomain(ctx.user.email)} />;
}
