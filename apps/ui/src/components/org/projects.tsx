import Link from "next/link";
import { projectHref } from "@/lib/routes";
import { type ContextOrg, plural, projectRoleLabel } from "@/lib/scope";
import "../org-settings/org-settings.css";
import "./org.css";

/**
 * `/org/<org>` (Supabase's organization home): the organization's projects you can see, one card
 * each with its name, slug, app count and your role; a card opens the project on `view` (your
 * home view). An organization without any shows an empty state instead.
 */
export function OrgProjects({ org, view }: { org: ContextOrg; view: string }) {
  const projects = org.projects;
  return (
    <div className="page os org-page">
      <header className="os-pagehead">
        <div>
          <p className="cp-h">{org.name}</p>
          <h1 className="cp-lede">Projects</h1>
        </div>
      </header>

      {projects.length === 0 ? (
        <div className="org-empty">
          <p className="org-empty__t">No projects in {org.name} yet</p>
          <p className="org-empty__p">Projects you create or are given access to in this organization show up here.</p>
        </div>
      ) : (
        <>
          <p className="org-count">{plural(projects.length, "project")}</p>
          <ul className="org-grid" aria-label={`Projects in ${org.name}`}>
            {projects.map((p) => (
              <li key={p.slug}>
                <Link href={projectHref(p.slug, view)} className="org-card">
                  <span className="st-mark org-card__mark" aria-hidden="true">
                    {p.name.trim()[0]?.toUpperCase() ?? "?"}
                  </span>
                  <span className="org-card__t">
                    <b>{p.name}</b>
                    <code>{p.slug}</code>
                  </span>
                  <span className="org-card__meta">
                    <span>{plural(p.app_count, "app")}</span>
                    <span className="org-badge">{projectRoleLabel(p.role)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
