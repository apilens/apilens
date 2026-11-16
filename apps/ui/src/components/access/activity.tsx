import Link from "next/link";
import type { ReactNode } from "react";
import { type ActivityFilters as Filters, type AUDIT_GROUPS, filtersQuery, groupLabel, hasFilters, retentionText } from "@/lib/audit";
import type { AuditEvent } from "@/lib/identity";
import { type SearchParams, trailHrefs } from "@/lib/pagination";
import { Pagination } from "../pagination/pagination";
import { ActivityFilters, type PersonOption, type ProjectOption } from "./activity-filters";
import { ActivityTable } from "./activity-table";
import "../security/security.css";
import "../org-settings/org-settings.css";
import "./activity.css";

/** Access › Activity's frame (#812): the title, the tabs and the tab's content. */
export function ActivityFrame({ projectName, nav, children }: { projectName: string; nav: ReactNode; children: ReactNode }) {
  return (
    <div className="page os acl">
      <header className="os-head">
        <p className="cp-h">{projectName} · Access</p>
        <h1 className="cp-lede">Activity</h1>
        {nav}
      </header>
      {children}
    </div>
  );
}

/** While the log loads: the filter bar and rows as placeholders. */
export function ActivitySkeleton() {
  return (
    <section className="os-card" aria-busy="true" aria-label="Loading the activity log">
      <div className="os-card__body acl-skeleton">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="acl-bone" aria-hidden="true" />
        ))}
      </div>
    </section>
  );
}

/**
 * A deep link without `audit.read` (on the organization's log: without being an owner or admin):
 * says so, instead of a blank page.
 */
export function ActivityNotAllowed({ scope = "project" }: { scope?: "project" | "org" }) {
  return (
    <section className="os-card" aria-labelledby="acl-denied">
      <div className="os-card__body pk-body">
        <div className="pk-empty">
          {scope === "org" ? (
            <>
              <h3 id="acl-denied">You can’t see this organization’s audit log</h3>
              <p>Only organization owners and admins can read who changed members, access, keys and settings. Ask an owner or admin if you need it.</p>
            </>
          ) : (
            <>
              <h3 id="acl-denied">You can’t see this project’s activity log</h3>
              <p>Only project admins can read who changed access, keys and settings. Ask an admin of this project if you need it.</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** The API could not answer. */
export function ActivityLoadFailed() {
  return (
    <section className="os-card">
      <div className="os-card__body pk-body">
        <p className="pk-load-err" role="alert">
          Couldn’t load the activity log. Reload the page to try again.
        </p>
      </div>
    </section>
  );
}

export interface ActivityViewProps {
  /** The CSV export route; the filters are appended as its query. */
  exportPath: string;
  /** `/<project>/access/activity` or `/orgs/<org>/settings/audit`. */
  pathname: string;
  params: SearchParams;
  filters: Filters;
  people: PersonOption[];
  /**
   * The organization's audit log (#813): its projects, offered as the Project filter and shown as
   * a Project column. Absent on a project's own log.
   */
  projects?: ProjectOption[];
  groups: readonly (typeof AUDIT_GROUPS)[number][];
  /** Each action's display name. */
  labels: Record<string, string>;
  events: AuditEvent[];
  /** The next page's cursor; null on the oldest page. */
  next: string | null;
  /** How many days events are kept (0: forever); null when unknown. */
  retentionDays: number | null;
  /** Whether the CSV export can hold the current filter (one action filter at most). */
  exportable: boolean;
  now: number;
}

/**
 * The populated or empty log: filters, the table, paging, the retention line and the export. One
 * component for a project's Activity tab and the organization's audit log, which adds `projects`.
 */
export function ActivityView(p: ActivityViewProps) {
  const pages = trailHrefs(p.pathname, p.params, p.next);
  const q = filtersQuery(p.filters);
  const exportHref = `${p.exportPath}${q ? `?${q}` : ""}`;
  const filtered = hasFilters(p.filters);
  const org = p.projects !== undefined;
  return (
    <section className="os-card" aria-label="Activity log">
      <div className="os-card__head acl-head">
        <div>
          <h2>Activity log</h2>
          <p>{org ? "Who changed members, access, keys and settings in this organization and its projects, newest first." : "Who changed access, keys and settings on this project, newest first."}</p>
        </div>
        {p.exportable ? (
          <a className="ah-btn ah-btn--secondary ah-btn--sm" href={exportHref} download>
            Export CSV
          </a>
        ) : (
          <div className="acl-export-off">
            <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" disabled aria-describedby="acl-export-why">
              Export CSV
            </button>
            <p id="acl-export-why" className="os-help">
              The export holds one kind of action at a time. Clear the {p.filters.group ? groupLabel(p.filters.group) : "action"} filter to export.
            </p>
          </div>
        )}
      </div>
      <div className="os-card__body">
        <ActivityFilters pathname={p.pathname} params={p.params} filters={p.filters} people={p.people} projects={p.projects} groups={p.groups} />
        {p.events.length === 0 ? (
          <div className="pk-empty acl-empty">
            {pages.page > 1 ? (
              <>
                <h3>No older activity</h3>
                <p>
                  <Link className="cp-link" href={pages.newestHref}>
                    Back to the newest
                  </Link>
                </p>
              </>
            ) : filtered ? (
              <>
                <h3>No activity matches these filters</h3>
                <p>
                  Try another {org ? "project, person" : "person"}, action or date range, or{" "}
                  <Link className="cp-link" href={p.pathname}>
                    clear the filters
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <h3>No activity yet</h3>
                <p>
                  {org
                    ? "When someone invites a member, grants access, creates or rotates a key, or changes a setting in this organization, it shows up here."
                    : "When someone grants access, creates or rotates a key, or changes a setting on this project, it shows up here."}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="acl-scroll">
            <ActivityTable events={p.events} labels={p.labels} now={p.now} scope={org ? "org" : "project"} />
          </div>
        )}
        <Pagination mode="cursor" newerHref={pages.newerHref} olderHref={pages.olderHref} label="Activity pages" className="acl-pager" />
        {p.retentionDays !== null ? <p className="os-help acl-retention">{retentionText(p.retentionDays)}</p> : null}
      </div>
    </section>
  );
}
