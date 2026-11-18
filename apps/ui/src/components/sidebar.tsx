"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { badgeText } from "@/lib/alerts";
import { PROJECT_SETTINGS, type Section, VIEWS } from "@/lib/data";
import type { User } from "@/lib/identity";
import { sidebarHref } from "@/lib/nav-scope";
import { navGroups } from "@/lib/nav-sections";
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
  /** Open incidents in the project (#610): the Incidents badge; 0 shows none. */
  openIncidents: number;
  collapsed: boolean;
  drawer?: boolean;
  onCollapse: () => void;
}

/**
 * One sidebar: the organization in the top cell, the project under it, the pages under their
 * section headings (Monitor and Catalog up top, Configure with Project settings at the bottom, #998), and at the foot your account and the collapse control. The app (service) and environment are
 * chosen in the top bar. The page links keep the current `range` and `env` (#992), so the scope travels.
 */
export function Sidebar({ user, orgs, org, project, view, orgScope, account = false, openIncidents, collapsed, drawer, onCollapse }: Props) {
  const search = useSearchParams();
  const row = (p: ContextProject, slug: string, label: string, icon: NavIconName, extra?: React.ReactNode) => {
    const on = !orgScope && view === slug;
    return (
      <Link key={slug} href={sidebarHref(p.slug, slug, search)} className={`cp-sitem${on ? " on" : ""}`} aria-current={on ? "page" : undefined} aria-label={collapsed ? label : undefined} data-tip={collapsed ? label : undefined}>
        <span className="sl">
          <NavIcon name={icon} active={on} />
        </span>
        <span className="lb">{label}</span>
        {extra}
      </Link>
    );
  };

  const open = badgeText(openIncidents);
  const item = (p: ContextProject) => (v: (typeof VIEWS)[number]) => {
    const badge =
      v.slug === "incidents" && open ? (
        <span className="ct w" title={`${open} open ${open === "1" ? "incident" : "incidents"}`}>
          {open}
        </span>
      ) : null;
    return row(p, v.slug, v.label, v.slug as NavIconName, badge);
  };

  // A labelled group per section; the heading hides in the collapsed rail (a divider stands in).
  const groups = navGroups();
  const group = (section: Section, rows: React.ReactNode[]) => {
    const id = `side-sh-${section.toLowerCase()}`;
    return (
      <div key={section} className="side-group" role="group" aria-labelledby={id}>
        <h2 id={id} className="cp-sh">
          {section}
        </h2>
        <div className="cp-snav">{rows}</div>
      </div>
    );
  };

  return (
    <aside className={`ah cp-side${collapsed ? " is-collapsed" : ""}`} aria-label="Sidebar">
      <div className="cp-brand side-orgcell">
        <OrgHeader orgs={orgs} org={org} orgScope={orgScope} collapsed={collapsed} />
      </div>

      {orgScope || !project ? null : <ProjectRow org={org} project={project} view={view} collapsed={collapsed} />}

      <nav className="side-nav side-nav--main" aria-label="Views">
        {project ? groups.filter((g) => g.section !== "Configure").map((g) => group(g.section, g.views.map(item(project)))) : null}
      </nav>

      <nav className="side-nav side-nav--settings" aria-label="Settings">
        {project
          ? groups
              .filter((g) => g.section === "Configure")
              .map((g) => group(g.section, [...g.views.map(item(project)), row(project, PROJECT_SETTINGS.slug, PROJECT_SETTINGS.label, "settings")]))
          : null}
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
 * when the project or the page changes; 0 until it answers and whenever it can't. Read once by the
 * shell for both the sidebar badge and the mobile bar.
 */
export function useOpenIncidents(project: string | undefined, view: string): number {
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
