import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgInvitationsSettings } from "@/components/org-settings/invitations";
import { OrgMembersSettings } from "@/components/org-settings/members";
import { getContext, getSession } from "@/lib/auth/server";
import { type Invitation, type Member, identity, isApiError } from "@/lib/identity";
import { type Viewer, orgCan } from "@/lib/org-members";
import type { SearchParams } from "@/lib/pagination";
import { orgHref } from "@/lib/routes";
import { findOrg } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import "@/components/org-settings/org-settings.css";

export const metadata: Metadata = { title: "Team" };

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

// Organization scope: Team (Supabase's), the members table (#345) with the pending invitations
// (#346) under it. What the signed-in user may do comes from the context's capabilities
// (`members.invite`, `members.remove`); the API checks every change again.
export default async function OrgTeamPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<SearchParams> }) {
  const { org: slug } = await params;
  const next = orgHref(slug, "team");
  const context = await getContext(next);
  const org = findOrg(context, slug);
  if (!org) notFound();
  const canInvite = orgCan(context, slug, "members.invite");
  const [members, invitations] = await Promise.all([loadMembers(slug, next), canInvite ? loadInvitations(slug, next) : Promise.resolve(null)]);
  const viewer: Viewer = {
    id: context.user.id,
    role: org.role,
    manage: orgCan(context, slug, "members.remove"),
    invite: canInvite,
  };
  const search = await searchParams;
  const ref = { slug: org.slug, name: org.name };
  return (
    <AppShell context={context} org={slug} view="team">
      <div className="page os om">
        <header className="os-pagehead">
          <div>
            <p className="cp-h">{org.name}</p>
            <h1 className="cp-lede">Team</h1>
          </div>
        </header>
        <OrgMembersSettings org={ref} members={members} viewer={viewer} search={search} />
        <OrgInvitationsSettings org={ref} invitations={invitations ?? []} manage={invitations !== null} now={Date.now()} search={search} />
      </div>
    </AppShell>
  );
}
