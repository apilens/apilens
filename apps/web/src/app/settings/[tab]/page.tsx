import { redirect } from "next/navigation";

const tabRedirects: Record<string, string> = {
  general: "/account/general",
  account: "/account/account",
  "api-keys": "/apps",
};

export default async function SettingsTabRedirect({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  redirect(tabRedirects[tab] || "/account/general");
}
