"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { badgeText } from "@/lib/alerts";
import { PROJECT_SETTINGS, VIEWS } from "@/lib/data";
import type { User } from "@/lib/identity";
import type { ContextOrg, ContextProject } from "@/lib/scope";
import { Icon } from "./icons";
import { NavIcon, type NavIconName } from "./nav-icons";
import { OrgHeader, ProjectRow } from "./scope-tree";
import { UserMenu } from "./user-menu";

interface Props {
  user: User;
  /** Every organization the user belongs to (the org menu). */
  orgs: ContextOrg[];
  org: ContextOrg;
  /** Undefined only in org scope for an organization without projects: no project pages then. */
  project?: ContextProject;
  view: string;
  orgScope: boolean;
  /** Account scope (`/settings/*`): Account settings is the current page. */
  account?: boolean;
  collapsed: boolean;
  drawer?: boolean;
  onCollapse: () => void;
}

/**
 * One sidebar: the organization in the top cell, the project under it, the main pages as one list,
 * then the settings pages, and at the foot your account and the collapse control. The app (service) and environment are
 * chosen in the top bar.
 */
export function Sidebar({ user, orgs, org, project, view, orgScope, account = false, collapsed, drawer, onCollapse }: Props) {
  const row = (p: ContextProject, slug: string, label: string, icon: NavIconName, extra?: React.ReactNode) => {
    const on = !orgScope && view === slug;
    return (
      <Link key={slug} href={`/${p.slug}/${slug}`} className={`cp-sitem${on ? " on" : ""}`} aria-current={on ? "page" : undefined} aria-label={collapsed ? label : undefined} data-tip={collapsed ? label : undefined}>
        <span className="sl">
          <NavIcon name={icon} active={on} />
        </span>
        <span className="lb">{label}</span>
        {extra}
      </Link>
    );
  };

  const open = badgeText(useOpenIncidents(project?.slug, view));
  const item = (p: ContextProject) => (v: (typeof VIEWS)[number]) => {
    const badge =
      v.slug === "incidents" && open ? (
        <span className="ct w" title={`${open} open ${open === "1" ? "incident" : "incidents"}`}>
          {open}
        </span>
      ) : null;
    return row(p, v.slug, v.label, v.slug as NavIconName, badge);
  };

  return (
    <aside className={`ah cp-side${collapsed ? " is-collapsed" : ""}`} aria-label="Sidebar">
      <div className="cp-brand side-orgcell">
        <OrgHeader orgs={orgs} org={org} orgScope={orgScope} collapsed={collapsed} />
      </div>

      {orgScope || !project ? null : <ProjectRow org={org} project={project} view={view} collapsed={collapsed} />}

      <nav className="side-nav side-nav--main" aria-label="Views">
        <div className="cp-snav">
          {project ? VIEWS.filter((v) => v.section !== "Configure").map(item(project)) : null}
        </div>
      </nav>

      <nav className="side-nav side-nav--settings" aria-label="Settings">
        <div className="cp-snav">
          {project ? VIEWS.filter((v) => v.section === "Configure").map(item(project)) : null}
          {project ? row(project, PROJECT_SETTINGS.slug, PROJECT_SETTINGS.label, "settings") : null}
        </div>
      </nav>

      <div className="cp-sfoot cp-sfoot--toggle side-foot">
        <UserMenu user={user} collapsed={collapsed} current={account} />
        <button type="button" className="cp-sbtn side-toggle" data-tip={collapsed && !drawer ? "Expand sidebar" : undefined} title={collapsed ? undefined : drawer ? "Close navigation" : "Collapse sidebar"} aria-label={drawer ? "Close navigation" : `${collapsed ? "Expand" : "Collapse"} sidebar`} onClick={onCollapse}>
          <Icon name={collapsed ? "panelOpen" : "panelClose"} />
        </button>
      </div>
    </aside>
  );
}

/**
 * How many of the project's incidents are open (#610), read from `GET /api/projects/{slug}/incidents`
 * when the project or the page changes; 0 until it answers and whenever it can't.
 */
function useOpenIncidents(project: string | undefined, view: string): number {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    if (!project) return setOpen(0);
    const ctrl = new AbortController();
    fetch(`/api/projects/${encodeURIComponent(project)}/incidents`, { signal: ctrl.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((b: { ok?: boolean; open?: number }) => setOpen(b?.ok === true && typeof b.open === "number" ? b.open : 0))
      .catch(() => {
        if (!ctrl.signal.aborted) setOpen(0);
      });
    return () => ctrl.abort();
  }, [project, view]);
  return open;
}
