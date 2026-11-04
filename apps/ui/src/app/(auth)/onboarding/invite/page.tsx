import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { InviteTeamScreen } from "@/components/onboarding/invite-team";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext } from "@/lib/auth/server";
import { canInvite } from "@/lib/onboarding-invite";

export const metadata: Metadata = { title: "Invite your team" };

const PATH = "/onboarding/invite";

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("invite");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext(PATH);
  const org = ctx.orgs.find((o) => o.projects.some((p) => p.slug === answers.project_slug));
  const project = org?.projects.find((p) => p.slug === answers.project_slug);
  // No project to invite people to yet: create one first.
  if (!org || !project) redirect("/onboarding/project");
  return (
    <InviteTeamScreen
      step={step}
      reached={reached}
      org={{ slug: org.slug, name: org.name }}
      project={{ slug: project.slug, name: project.name }}
      canInvite={canInvite(org.role)}
      invited={answers.invited ?? 0}
    />
  );
}
