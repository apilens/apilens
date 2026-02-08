import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { DashboardLayout } from "@/components/dashboard";
import { SettingsPage } from "@/components/settings";
import { SettingsTab } from "@/components/settings/SettingsSidebar";

const validTabs: SettingsTab[] = ["general", "account", "api-keys"];

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const tabTitles: Record<string, string> = {
    general: "General Settings",
    account: "Account Settings",
    "api-keys": "API Keys",
  };

  return {
    title: `${tabTitles[tab] || "Settings"} | APILens`,
    description: "Manage your settings and preferences",
  };
}

export default async function SettingsTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const session = await getSession();

  if (!session) {
    redirect("/auth/login");
  }

  const { tab } = await params;

  if (!validTabs.includes(tab as SettingsTab)) {
    notFound();
  }

  return (
    <DashboardLayout>
      <SettingsPage initialTab={tab as SettingsTab} />
    </DashboardLayout>
  );
}
