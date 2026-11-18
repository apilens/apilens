import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { IncidentsMenu } from "@/components/shell/section-menu";
import { getContext } from "@/lib/auth/server";
import { PATH_HEADER } from "@/lib/project-redirect";
import { projectHref } from "@/lib/routes";
import { findProject } from "@/lib/scope";

// Incidents' shell and secondary sidebar (#1051): Incidents (with the open count) and Alert rules.
// Rendered here, not by the pages, so both stay mounted between them, an incident's timeline and
// the rule editor. A project the user cannot see renders the page alone, which answers 404.
export default async function IncidentsLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  const path = (await headers()).get(PATH_HEADER)?.split("?")[0] || projectHref(project, "incidents");
  const context = await getContext(path);
  if (!findProject(context, project)) return children;
  return (
    <AppShell context={context} project={project} view="incidents" menu={<IncidentsMenu project={project} />}>
      {children}
    </AppShell>
  );
}
