import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { VIEWS, projectBySlug } from "@/lib/data";

type Params = { project: string; view: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { view } = await params;
  return { title: VIEWS.find((v) => v.slug === view)?.label ?? "APILens" };
}

// The shell (sidebar, top bar, scope switcher) is built; page content is intentionally empty for now.
export default async function Page({ params }: { params: Promise<Params> }) {
  const { project, view } = await params;
  if (!projectBySlug(project) || !VIEWS.some((v) => v.slug === view)) notFound();
  return <AppShell project={project} view={view} />;
}
