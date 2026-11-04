import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { projectBySlug } from "@/lib/data";

export const metadata: Metadata = { title: "Apps" };

// Content comes later.
export default async function AppsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  if (!projectBySlug(project)) notFound();
  return <AppShell project={project} view="apps" />;
}
