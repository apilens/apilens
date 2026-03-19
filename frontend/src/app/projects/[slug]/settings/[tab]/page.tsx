import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ProjectSettingsContent from "../ProjectSettingsContent";
import type { ProjectSettingsTab } from "@/components/projects/ProjectSettingsSidebar";

const validTabs: ProjectSettingsTab[] = ["general", "api-keys"];

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const tabTitles: Record<string, string> = {
    general: "General",
    "api-keys": "API Keys",
  };

  return {
    title: `${tabTitles[tab] || "Settings"} — Project Settings | APILens`,
  };
}

export default async function ProjectSettingsTabPage({
  params,
}: {
  params: Promise<{ slug: string; tab: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug, tab } = await params;

  if (!validTabs.includes(tab as ProjectSettingsTab)) {
    notFound();
  }

  return <ProjectSettingsContent projectSlug={slug} initialTab={tab as ProjectSettingsTab} />;
}
