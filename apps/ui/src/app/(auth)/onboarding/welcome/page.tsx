import type { Metadata } from "next";
import { Welcome } from "@/components/onboarding/welcome";
import { getJoinableOrgs, getMyInvitations, requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { emailDomain } from "@/lib/join-org";
import { savedAnswers } from "@/lib/onboarding-save";
import { welcomeCards } from "@/lib/welcome";

export const metadata: Metadata = { title: "Welcome" };

const PATH = "/onboarding/welcome";

// The only onboarding screen: the user's name and the organization their projects live in.
export default async function Page() {
  await requireOnboardingStep("welcome");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext(PATH);
  const [invitations, joinable] = await Promise.all([getMyInvitations(PATH), getJoinableOrgs(PATH)]);
  return (
    <Welcome
      cards={welcomeCards(ctx, invitations, joinable)}
      name={ctx.user.name ?? ""}
      domain={emailDomain(ctx.user.email)}
      host={new URL(env().publicUrl).host}
      owned={ctx.orgs.filter((o) => o.role === "owner").map((o) => o.slug)}
      preferred={savedAnswers(ctx).org_slug ?? ""}
    />
  );
}
