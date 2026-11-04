import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgMembersSettings } from "@/components/org-settings/members";
import { getContext, getSession } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { type Member, identity, isApiError } from "@/lib/identity";
import { type Viewer, orgCan } from "@/lib/org-members";
import { findOrg } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: `Members · ${ORG_SETTINGS.label}` };

/** `GET /orgs/{slug}/members`: everyone in the organization, oldest member first. */
async function loadMembers(slug: string, next: string): Promise<Member[]> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listMembers(slug, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err) && err.status === 404) notFound();
    throw err;
  }
}

// Organization scope: the members table (#345). What the signed-in user may do comes from the
// context's capabilities (`members.invite`, `members.remove`); the API checks every change again.
export default async function OrgMembersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const next = `/orgs/${slug}/settings/members`;
  const context = await getContext(next);
  const org = findOrg(context, slug);
  if (!org) notFound();
  const members = await loadMembers(slug, next);
  const viewer: Viewer = {
    id: context.user.id,
    role: org.role,
    manage: orgCan(context, slug, "members.remove"),
    invite: orgCan(context, slug, "members.invite"),
  };
  return (
    <AppShell context={context} org={slug} view="settings">
      <OrgMembersSettings org={{ slug: org.slug, name: org.name }} members={members} viewer={viewer} />
    </AppShell>
  );
}
