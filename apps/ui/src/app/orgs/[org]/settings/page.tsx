import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ORGS, ORG_SETTINGS } from "@/lib/data";

export const metadata: Metadata = { title: ORG_SETTINGS.label };

// Organization scope: no project in the breadcrumb. Content comes later.
export default async function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  if (!ORGS.some((o) => o.slug === org)) notFound();
  return <AppShell org={org} view="settings" />;
}
