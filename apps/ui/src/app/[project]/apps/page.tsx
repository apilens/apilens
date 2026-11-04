import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { findProject } from "@/lib/scope";

export const metadata: Metadata = { title: "Apps" };

// Content comes later.
export default async function AppsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const context = await getContext(`/${project}/apps`);
  if (!findProject(context, project)) notFound();
  return <AppShell context={context} project={project} view="apps" />;
}
