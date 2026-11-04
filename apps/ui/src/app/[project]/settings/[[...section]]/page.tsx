import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { PROJECT_SETTINGS } from "@/lib/data";
import { findProject } from "@/lib/scope";

export const metadata: Metadata = { title: PROJECT_SETTINGS.label };

const SECTIONS = ["", "environments", "keys", "sdk", "retention", "integrations", "danger"];

// Content comes later.
export default async function SettingsPage({ params }: { params: Promise<{ project: string; section?: string[] }> }) {
  const { project, section } = await params;
  if (section && (section.length > 1 || !SECTIONS.includes(section[0]))) notFound();
  const context = await getContext(`/${project}/settings${section?.[0] ? `/${section[0]}` : ""}`);
  if (!findProject(context, project)) notFound();
  return <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug} />;
}
