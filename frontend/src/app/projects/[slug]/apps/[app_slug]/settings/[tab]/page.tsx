import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { AppProvider } from "@/components/providers/AppProvider";
import AppSettingsPage from "@/components/apps/AppSettingsPage";
import type { AppSettingsTab } from "@/components/apps/AppSettingsSidebar";

export const metadata = {
  title: "App Settings | APILens",
};

export default async function ProjectAppSettingsPage({
  params,
}: {
  params: Promise<{ slug: string; app_slug: string; tab: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug, app_slug, tab } = await params;

  // Validate tab
  const validTabs: AppSettingsTab[] = ["general", "api-keys", "setup"];
  const activeTab = validTabs.includes(tab as AppSettingsTab)
    ? (tab as AppSettingsTab)
    : "general";

  return (
    <AppProvider appSlug={app_slug} projectSlug={slug}>
      <AppSettingsPage appSlug={app_slug} projectSlug={slug} initialTab={activeTab} />
    </AppProvider>
  );
}
