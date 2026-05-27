import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { AccountLayout } from "@/components/dashboard";
import { AccountSettingsPage } from "@/components/account";
import type { AccountSettingsTab } from "@/components/account/AccountSettingsSidebar";

const validTabs: AccountSettingsTab[] = ["general", "account"];

export async function generateMetadata({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const tabTitles: Record<string, string> = {
    general: "General",
    account: "Account",
  };

  return {
    title: `${tabTitles[tab] || "Account"} — Account Settings | APILens`,
  };
}

export default async function AccountSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { tab } = await params;

  if (!validTabs.includes(tab as AccountSettingsTab)) {
    notFound();
  }

  return (
    <AccountLayout>
      <AccountSettingsPage initialTab={tab as AccountSettingsTab} />
    </AccountLayout>
  );
}
