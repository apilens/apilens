import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgSSOSettings } from "@/components/org-settings/sso";
import { getContext, getSession } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { type SSOConnection, identity, isApiError } from "@/lib/identity";
import { canManageSSO } from "@/lib/org-sso";
import { findOrg } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: `Single sign-on · ${ORG_SETTINGS.label}` };

/** `GET /orgs/{slug}/sso`: the connection, or null when there is none yet (409 `sso_not_configured`). */
async function loadConnection(slug: string, next: string): Promise<SSOConnection | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getOrgSSO(slug, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err) && err.code === "sso_not_configured") return null;
    if (isApiError(err) && err.status === 404) notFound();
    throw err;
  }
}

// Organization scope: the OIDC connection (#348). Only owners may read or change it, so the API
// is not asked for anyone else; they see why instead.
export default async function OrgSSOPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const next = `/orgs/${slug}/settings/sso`;
  const context = await getContext(next);
  const org = findOrg(context, slug);
  if (!org) notFound();
  const owner = canManageSSO(org.role);
  const connection = owner ? await loadConnection(slug, next) : null;
  return (
    <AppShell context={context} org={slug} view="settings">
      <OrgSSOSettings org={{ slug: org.slug, name: org.name, role: org.role }} connection={connection} />
    </AppShell>
  );
}
