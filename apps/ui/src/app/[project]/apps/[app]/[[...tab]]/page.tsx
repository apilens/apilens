import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { appBySlug } from "@/lib/data";
import { findProject } from "@/lib/scope";

const TABS = ["", "instrumentation", "configuration", "deploys"];

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }): Promise<Metadata> {
  const { app } = await params;
  return { title: app };
}

// One app (service). Content comes later.
export default async function AppPage({ params }: { params: Promise<{ project: string; app: string; tab?: string[] }> }) {
  const { project, app, tab } = await params;
  if (!appBySlug(project, app) || (tab && (tab.length > 1 || !TABS.includes(tab[0])))) notFound();
  const context = await getContext(`/${project}/apps/${app}${tab?.[0] ? `/${tab[0]}` : ""}`);
  if (!findProject(context, project)) notFound();
  return <AppShell context={context} project={project} view="apps" />;
}
