import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { NewProject } from "@/components/org/new-project";
import { getContext } from "@/lib/auth/server";
import { newProjectHref } from "@/lib/routes";
import { canCreateProject } from "@/lib/project-create";
import { findOrg } from "@/lib/scope";

export const metadata: Metadata = { title: "Create project" };

// `/org/<org>/projects/new`: create another project in an organization the user can manage.
export default async function NewProjectPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const context = await getContext(newProjectHref(slug));
  const org = findOrg(context, slug);
  if (!org || !canCreateProject(org.role)) notFound();
  const orgs = context.orgs.filter((o) => canCreateProject(o.role)).map((o) => ({ slug: o.slug, name: o.name }));
  return (
    <AppShell context={context} org={slug} view="projects">
      <NewProject org={slug} orgs={orgs} />
    </AppShell>
  );
}
