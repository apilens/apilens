import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActivityLoadFailed, ActivityNotAllowed, ActivitySkeleton, ActivityView } from "@/components/access/activity";
import type { PersonOption, ProjectOption } from "@/components/access/activity-filters";
import { AppShell } from "@/components/app-shell";
import { OrgSettingsNav } from "@/components/org-settings/nav";
import { getContext } from "@/lib/auth/server";
import { exportFilters, offeredGroups, orgAuditScope, parseActivityFilters } from "@/lib/audit";
import { auditCaller, loadActivityPage } from "@/lib/audit-load";
import { ORG_SETTINGS } from "@/lib/data";
import { identity } from "@/lib/identity";
import { memberName } from "@/lib/org-members";
import { canReadOrgAudit } from "@/lib/org-settings";
import type { SearchParams } from "@/lib/pagination";
import { findOrg } from "@/lib/scope";
import "@/components/org-settings/org-settings.css";

export const metadata: Metadata = { title: `Audit log · ${ORG_SETTINGS.label}` };

/** Events a page shows (as on a project's Activity tab). */
const AUDIT_PAGE = 25;

/**
 * The log itself: the action catalogue, the organization's members (for the Person filter) and
 * one page of events, of the whole organization or of the project the Project filter names.
 */
async function OrgAuditLog({ org, projects, search, next }: { org: string; projects: ProjectOption[]; search: SearchParams; next: string }) {
  const { scope, filters } = orgAuditScope(
    org,
    parseActivityFilters(search),
    projects.map((p) => p.slug),
  );
  const call = await auditCaller(next);
  const [page, members] = await Promise.all([
    loadActivityPage({ scope, catalogue: { org }, filters, search, next, limit: AUDIT_PAGE }),
    call((o) => identity().listMembers(org, o)),
  ]);
  if (page === "forbidden") return <ActivityNotAllowed scope="org" />;
  if (page === null) return <ActivityLoadFailed />;

  // A project's own log leaves the project out of each event: it is the one asked for.
  const named = "project" in scope ? projects.find((p) => p.slug === scope.project) : undefined;
  const events = named ? page.events.map((e) => ({ ...e, project: e.project ?? named })) : page.events;
  const people: PersonOption[] = members && members !== "forbidden" ? members.map((m) => ({ id: m.user.id, name: memberName(m) })) : [];

  return (
    <ActivityView
      exportPath={`/api/orgs/${encodeURIComponent(org)}/audit-export`}
      pathname={`/orgs/${org}/settings/audit`}
      params={search}
      filters={filters}
      people={people}
      projects={projects}
      groups={offeredGroups(page.actions)}
      labels={Object.fromEntries(page.actions.map((a) => [a.action, a.label]))}
      events={events}
      next={page.next}
      retentionDays={page.retentionDays}
      exportable={exportFilters(filters, page.actions) !== null}
      now={Date.now()}
    />
  );
}

// Organization scope: the audit log across the organization and its projects (#813, #753 D7), the
// same table, filters, detail panel and export as a project's Access › Activity, plus a Project
// filter and column. Owners and admins only: the tab is hidden for anyone else, and a direct link
// shows the not-allowed state instead of asking the API.
export default async function OrgAuditPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<SearchParams> }) {
  const { org: slug } = await params;
  const next = `/orgs/${slug}/settings/audit`;
  const context = await getContext(next);
  const org = findOrg(context, slug);
  if (!org) notFound();
  const search = await searchParams;
  const projects: ProjectOption[] = org.projects.map((p) => ({ slug: p.slug, name: p.name }));
  return (
    <AppShell context={context} org={slug} view="settings">
      <div className="page os acl">
        <header className="os-head">
          <p className="cp-h">Organization</p>
          <h1 className="cp-lede">Audit log</h1>
          <OrgSettingsNav org={org.slug} current="audit" role={org.role} />
        </header>
        {canReadOrgAudit(org.role) ? (
          <Suspense key={JSON.stringify(search)} fallback={<ActivitySkeleton />}>
            <OrgAuditLog org={org.slug} projects={projects} search={search} next={next} />
          </Suspense>
        ) : (
          <ActivityNotAllowed scope="org" />
        )}
      </div>
    </AppShell>
  );
}
