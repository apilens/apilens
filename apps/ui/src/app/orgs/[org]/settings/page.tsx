import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgGeneralSettings } from "@/components/org-settings/general";
import { getContext, getSession } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { type Org, identity, isApiError } from "@/lib/identity";
import { findOrg } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: ORG_SETTINGS.label };

/** `GET /orgs/{slug}`: the settings (allowed domains, domain join) the context does not carry. */
async function loadOrg(slug: string, next: string): Promise<Org> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getOrg(slug, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err) && err.status === 404) notFound();
    throw err;
  }
}

// Organization scope: no project in the breadcrumb. General settings and the danger zone (#347).
export default async function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const next = `/orgs/${org}/settings`;
  const context = await getContext(next);
  if (!findOrg(context, org)) notFound();
  const detail = await loadOrg(org, next);
  return (
    <AppShell context={context} org={org} view="settings">
      <OrgGeneralSettings org={detail} />
    </AppShell>
  );
}
