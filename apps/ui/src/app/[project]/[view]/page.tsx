import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { VIEWS } from "@/lib/data";
import { findProject } from "@/lib/scope";

type Params = { project: string; view: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { view } = await params;
  return { title: VIEWS.find((v) => v.slug === view)?.label ?? "APILens" };
}

// The shell (sidebar, top bar, scope switcher) is built; page content is intentionally empty for now.
export default async function Page({ params }: { params: Promise<Params> }) {
  const { project, view } = await params;
  if (!VIEWS.some((v) => v.slug === view)) notFound();
  const context = await getContext(`/${project}/${view}`);
  if (!findProject(context, project)) notFound();
  return <AppShell context={context} project={project} view={view} />;
}
