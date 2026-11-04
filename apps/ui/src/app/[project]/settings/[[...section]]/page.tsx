import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PROJECT_SETTINGS, projectBySlug } from "@/lib/data";

export const metadata: Metadata = { title: PROJECT_SETTINGS.label };

const SECTIONS = ["", "environments", "keys", "sdk", "retention", "integrations", "danger"];

// Content comes later.
export default async function SettingsPage({ params }: { params: Promise<{ project: string; section?: string[] }> }) {
  const { project, section } = await params;
  if (!projectBySlug(project) || (section && (section.length > 1 || !SECTIONS.includes(section[0])))) notFound();
  return <AppShell project={project} view={PROJECT_SETTINGS.slug} />;
}
