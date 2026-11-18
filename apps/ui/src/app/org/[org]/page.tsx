import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgProjects } from "@/components/org/projects";
import { getContext } from "@/lib/auth/server";
import { homeView } from "@/lib/landing";
import { orgHref } from "@/lib/routes";
import { findOrg } from "@/lib/scope";

export const metadata: Metadata = { title: "Projects" };

// Organization scope's home (Supabase's `/org/<slug>`): the organization's projects.
export default async function OrgProjectsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const context = await getContext(orgHref(slug));
  const org = findOrg(context, slug);
  if (!org) notFound();
  return (
    <AppShell context={context} org={slug} view="projects">
      <OrgProjects org={org} view={homeView(context)} />
    </AppShell>
  );
}
