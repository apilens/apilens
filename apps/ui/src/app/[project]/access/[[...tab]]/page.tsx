import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessNav } from "@/components/access/nav";
import { NotBuiltAccessTab } from "@/components/access/not-built";
import { AppShell } from "@/components/app-shell";
import { accessTab, accessTitle, visibleAccessTabs } from "@/lib/access";
import { getContext } from "@/lib/auth/server";
import type { SearchParams } from "@/lib/pagination";
import { findProject } from "@/lib/scope";
import type { SectionContext } from "../../settings/sections/types";
import * as keys from "../keys";

type Params = { project: string; tab?: string[] };

/** The Access view's slug in the sidebar (`VIEWS` in `lib/data.ts`). */
const VIEW = "access";

const pathOf = (project: string, tab: string[] | undefined) => `/${project}/access${tab?.[0] ? `/${tab[0]}` : ""}`;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { project, tab } = await params;
  const scoped = findProject(await getContext(pathOf(project, tab)), project);
  return { title: accessTitle(scoped?.project.name ?? project) };
}

// `/<project>/access` (Members), `/access/keys` (API keys) and `/access/activity` (Activity, only
// with `audit.read`; a deep link without it is a 404 like any tab the user cannot see).
export default async function AccessPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { project, tab } = await params;
  const next = pathOf(project, tab);
  const context = await getContext(next);
  const scoped = findProject(context, project);
  if (!scoped) notFound();
  const tabs = visibleAccessTabs(context.capabilities, project);
  const found = accessTab(tab, tabs);
  if (!found) notFound();
  const ctx: SectionContext = { project, projectName: scoped.project.name, context, search: await searchParams, next };
  const nav = <AccessNav project={project} tabs={tabs} current={found.slug} />;

  return (
    <AppShell context={context} project={project} view={VIEW}>
      {found.slug === "keys" ? keys.render(await keys.load(ctx), ctx, nav) : <NotBuiltAccessTab projectName={ctx.projectName} tab={found} nav={nav} />}
    </AppShell>
  );
}
