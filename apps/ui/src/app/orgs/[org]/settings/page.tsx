import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { findOrg } from "@/lib/scope";

export const metadata: Metadata = { title: ORG_SETTINGS.label };

// Organization scope: no project in the breadcrumb. Content comes later.
export default async function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await getContext(`/orgs/${org}/settings`);
  if (!findOrg(context, org)) notFound();
  return <AppShell context={context} org={org} view="settings" />;
}
