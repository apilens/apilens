import { redirect, notFound } from "next/navigation";
import { auth0 } from "@/lib/auth0";
import { DashboardLayout } from "@/components/dashboard";
import { SettingsPage } from "@/components/settings";
import { SettingsTab } from "@/components/settings/SettingsSidebar";

const validTabs: SettingsTab[] = ["general", "account"];

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const tabTitles: Record<string, string> = {
    general: "General Settings",
    account: "Account Settings",
  };

  return {
    title: `${tabTitles[tab] || "Settings"} | APILens`,
    description: "Manage your settings and preferences",
  };
}

export default async function SettingsTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const session = await auth0.getSession();

  if (!session) {
    redirect("/auth/login");
  }

  const { tab } = await params;

  // Validate tab parameter
  if (!validTabs.includes(tab as SettingsTab)) {
    notFound();
  }

  return (
    <DashboardLayout>
      <SettingsPage initialTab={tab as SettingsTab} />
    </DashboardLayout>
  );
}
