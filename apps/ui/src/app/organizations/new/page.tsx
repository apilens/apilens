import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { NewOrg } from "@/components/org/new-org";
import { getContext } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { onboardingPath } from "@/lib/landing";
import { newOrgHref } from "@/lib/routes";

export const metadata: Metadata = { title: "Create organization" };

// `/organizations/new`: create another organization once onboarding is done (#1051 follow-up).
export default async function NewOrganizationPage() {
  const context = await getContext(newOrgHref());
  // Someone with no organization at all belongs in onboarding, which creates
  // their first one; onboarding stays "not completed" for plenty of users who
  // are long past it, so having one is the test that matters.
  if (context.orgs.length === 0) redirect(onboardingPath(context.onboarding?.step));
  const owned = context.orgs.filter((o) => o.role === "owner").map((o) => o.slug);
  return (
    <AppShell context={context} account view="organizations">
      <NewOrg host={new URL(env().publicUrl).host} owned={owned} />
    </AppShell>
  );
}
