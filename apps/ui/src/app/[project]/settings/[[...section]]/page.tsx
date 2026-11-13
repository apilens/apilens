import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ProjectSettingsFrame } from "@/components/project-settings/frame";
import { NotBuiltSection } from "@/components/project-settings/not-built";
import { KEYS_SECTION } from "@/lib/api-keys";
import { getContext } from "@/lib/auth/server";
import { PROJECT_SETTINGS } from "@/lib/data";
import type { SearchParams } from "@/lib/pagination";
import { projectSection, projectSectionTitle, visibleProjectSections } from "@/lib/project-settings";
import { findProject } from "@/lib/scope";
import { SECTION_CONTENT } from "../sections";
import * as keys from "../sections/keys";
import { type SectionContext, section as toSection } from "../sections/types";

type Params = { project: string; section?: string[] };

/** API keys answer here until Access › API keys takes them over (#801); they are not in the nav. */
const isKeys = (section: string[] | undefined) => section?.length === 1 && section[0] === KEYS_SECTION;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { section } = await params;
  const found = projectSection(section);
  return { title: found ? projectSectionTitle(found) : PROJECT_SETTINGS.label };
}

// The page looks the section up: its content comes from `sections/<slug>.tsx` via the registry
// (`sections/index.ts`); a section without content shows "Nothing here yet".
export default async function SettingsPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { project, section } = await params;
  const found = projectSection(section);
  if (!found && !isKeys(section)) notFound();
  const next = `/${project}/settings${section?.[0] ? `/${section[0]}` : ""}`;
  const context = await getContext(next);
  const scoped = findProject(context, project);
  if (!scoped) notFound();
  const ctx: SectionContext = { project, projectName: scoped.project.name, context, search: await searchParams, next };

  if (!found) {
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        {await toSection(keys)(ctx)}
      </AppShell>
    );
  }

  const content = SECTION_CONTENT[found.slug];
  return (
    <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
      <ProjectSettingsFrame project={project} sections={visibleProjectSections(context.capabilities, project, found.slug)} current={found.slug}>
        {content ? await content(ctx) : <NotBuiltSection projectName={ctx.projectName} section={found} />}
      </ProjectSettingsFrame>
    </AppShell>
  );
}
