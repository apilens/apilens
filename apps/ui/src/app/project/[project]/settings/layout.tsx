import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SectionMenu } from "@/components/shell/section-menu";
import { getContext } from "@/lib/auth/server";
import { PROJECT_SETTINGS } from "@/lib/data";
import { PATH_HEADER } from "@/lib/project-redirect";
import { projectHref } from "@/lib/routes";
import { findProject } from "@/lib/scope";
import { projectSettingsMenu } from "@/lib/section-menus";
import { SECTION_CONTENT } from "./sections";

/** The sections with content; the menu hides the rest (#1051). */
const BUILT: ReadonlySet<string> = new Set(Object.keys(SECTION_CONTENT));

// Project settings' shell and secondary sidebar (#1051). Rendered here, not by the pages, so both
// stay mounted while you move between sections: only the content pane changes. A project the user
// cannot see renders the page alone, which answers 404.
export default async function ProjectSettingsLayout({ children, params }: { children: ReactNode; params: Promise<{ project: string }> }) {
  const { project } = await params;
  // The page's own path (without its query), so this shares the page's cached context call.
  const path = (await headers()).get(PATH_HEADER)?.split("?")[0] || projectHref(project, PROJECT_SETTINGS.slug);
  const context = await getContext(path);
  if (!findProject(context, project)) return children;
  return (
    <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug} menu={<SectionMenu {...projectSettingsMenu(project, context.capabilities, BUILT)} />}>
      {children}
    </AppShell>
  );
}
