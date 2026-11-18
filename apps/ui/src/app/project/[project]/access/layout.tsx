import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SectionMenu } from "@/components/shell/section-menu";
import { getContext } from "@/lib/auth/server";
import { PATH_HEADER } from "@/lib/project-redirect";
import { projectHref } from "@/lib/routes";
import { findProject } from "@/lib/scope";
import { accessMenu } from "@/lib/section-menus";

// Access's shell and secondary sidebar (#1051): Members, API keys and Activity. Rendered here, not
// by the page, so both stay mounted between them. A project the user cannot see renders the page
// alone, which answers 404.
export default async function AccessLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  const path = (await headers()).get(PATH_HEADER)?.split("?")[0] || projectHref(project, "access");
  const context = await getContext(path);
  if (!findProject(context, project)) return children;
  return (
    <AppShell context={context} project={project} view="access" menu={<SectionMenu {...accessMenu(project, context.capabilities)} />}>
      {children}
    </AppShell>
  );
}
