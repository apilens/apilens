import { notFound } from "next/navigation";
import { AppSettingsPage } from "@/components/apps";
import type { AppSettingsTab } from "@/components/apps/AppSettingsSidebar";

const validTabs: AppSettingsTab[] = ["general", "api-keys"];

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const tabTitles: Record<string, string> = {
    general: "General",
    "api-keys": "API Keys",
  };

  return {
    title: `${tabTitles[tab] || "Settings"} — App Settings | APILens`,
  };
}

export default async function AppSettingsTabPage({
  params,
}: {
  params: Promise<{ slug: string; tab: string }>;
}) {
  const { slug, tab } = await params;

  if (!validTabs.includes(tab as AppSettingsTab)) {
    notFound();
  }

  return <AppSettingsPage appSlug={slug} initialTab={tab as AppSettingsTab} />;
}
