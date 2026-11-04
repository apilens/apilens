import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgInvitationsSettings } from "@/components/org-settings/invitations";
import { getContext, getSession } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { type Invitation, identity, isApiError } from "@/lib/identity";
import { orgCan } from "@/lib/org-members";
import { findOrg } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: `Invitations · ${ORG_SETTINGS.label}` };

/**
 * `GET /orgs/{slug}/invitations`: pending invitations, newest first; null when the API says the
 * user may not see them (owners and admins only).
 */
async function loadInvitations(slug: string, next: string): Promise<Invitation[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listInvitations(slug, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err) && err.status === 404) notFound();
    if (isApiError(err) && err.status === 403) return null;
    throw err;
  }
}

// Organization scope: pending invitations (#346). Whether the user manages them comes from the
// context's `members.invite` capability; the API checks every change again.
export default async function OrgInvitationsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const next = `/orgs/${slug}/settings/invitations`;
  const context = await getContext(next);
  const org = findOrg(context, slug);
  if (!org) notFound();
  const invitations = orgCan(context, slug, "members.invite") ? await loadInvitations(slug, next) : null;
  return (
    <AppShell context={context} org={slug} view="settings">
      <OrgInvitationsSettings org={{ slug: org.slug, name: org.name }} invitations={invitations ?? []} manage={invitations !== null} now={Date.now()} />
    </AppShell>
  );
}
