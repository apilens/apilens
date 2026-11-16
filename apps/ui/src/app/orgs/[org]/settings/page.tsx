import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { OrgGeneralSettings } from "@/components/org-settings/general";
import { getContext, getSession } from "@/lib/auth/server";
import { ORG_SETTINGS } from "@/lib/data";
import { type DeletedProject, type Org, identity, isApiError } from "@/lib/identity";
import { canManageOrg } from "@/lib/org-settings";
import type { SearchParams } from "@/lib/pagination";
import { PROJECT_SLUG } from "@/lib/project-general";
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

/**
 * `GET /orgs/{slug}/projects/deleted` (#822) for owners and admins: null when it could not be
 * loaded (the card says so), undefined for everyone else (no card).
 */
async function loadDeleted(org: Org, next: string): Promise<DeletedProject[] | null | undefined> {
  if (!canManageOrg(org.role)) return undefined;
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listDeletedProjects(org.slug, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return err.status === 403 ? undefined : null;
    throw err;
  }
}

// Organization scope: no project in the breadcrumb. General settings and the danger zone (#347).
export default async function OrgSettingsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<SearchParams> }) {
  const { org } = await params;
  // `?deleted=<slug>`: a project's danger zone (#821) landed here after deleting it.
  const { deleted } = await searchParams;
  const next = `/orgs/${org}/settings`;
  const context = await getContext(next);
  if (!findOrg(context, org)) notFound();
  const detail = await loadOrg(org, next);
  const deletedProjects = await loadDeleted(detail, next);
  return (
    <AppShell context={context} org={org} view="settings">
      <OrgGeneralSettings
        org={detail}
        deletedProject={typeof deleted === "string" && PROJECT_SLUG.test(deleted) ? deleted : null}
        deletedProjects={deletedProjects}
      />
    </AppShell>
  );
}
