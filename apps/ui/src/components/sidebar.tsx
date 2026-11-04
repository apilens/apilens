"use client";

import Link from "next/link";
import { PROJECT_SETTINGS, VIEWS, appsIn, needsAttention, type Org, type Project } from "@/lib/data";
import { Icon } from "./icons";
import { NavIcon, type NavIconName } from "./nav-icons";
import { OrgHeader, ProjectRow } from "./scope-tree";
import { UserMenu } from "./user-menu";

interface Props {
  org: Org;
  project: Project;
  view: string;
  orgScope: boolean;
  collapsed: boolean;
  drawer?: boolean;
  onCollapse: () => void;
}

/**
 * One sidebar: the organization in the top cell, the project under it, the main pages as one list,
 * then the settings pages, and at the foot your account and the collapse control. The app (service) and environment are
 * chosen in the top bar.
 */
export function Sidebar({ org, project, view, orgScope, collapsed, drawer, onCollapse }: Props) {
  const row = (slug: string, label: string, icon: NavIconName, extra?: React.ReactNode) => {
    const on = !orgScope && view === slug;
    return (
      <Link key={slug} href={`/${project.slug}/${slug}`} className={`cp-sitem${on ? " on" : ""}`} aria-current={on ? "page" : undefined} aria-label={collapsed ? label : undefined} data-tip={collapsed ? label : undefined}>
        <span className="sl">
          <NavIcon name={icon} active={on} />
        </span>
        <span className="lb">{label}</span>
        {extra}
      </Link>
    );
  };

  const item = (v: (typeof VIEWS)[number]) => {
    const attention = v.slug === "apps" ? appsIn(project.slug).filter(needsAttention).length : 0;
    const badge = "badge" in v ? v.badge : attention ? String(attention) : null;
    const warn = "warn" in v || attention > 0;
    return row(v.slug, v.label, v.slug as NavIconName, badge ? <span className={`ct${warn ? " w" : ""}`} title={v.slug === "apps" ? `${attention} apps need attention` : undefined}>{badge}</span> : null);
  };

  return (
    <aside className={`ah cp-side${collapsed ? " is-collapsed" : ""}`} aria-label="Sidebar">
      <div className="cp-brand side-orgcell">
        <OrgHeader org={org} orgScope={orgScope} collapsed={collapsed} />
      </div>

      {orgScope ? null : <ProjectRow org={org} project={project} view={view} collapsed={collapsed} />}

      <nav className="side-nav side-nav--main" aria-label="Views">
        <div className="cp-snav">
          {VIEWS.filter((v) => v.section !== "Configure").map(item)}
        </div>
      </nav>

      <nav className="side-nav side-nav--settings" aria-label="Settings">
        <div className="cp-snav">
          {VIEWS.filter((v) => v.section === "Configure").map(item)}
          {row(PROJECT_SETTINGS.slug, PROJECT_SETTINGS.label, "settings")}
        </div>
      </nav>

      <div className="cp-sfoot cp-sfoot--toggle side-foot">
        <UserMenu collapsed={collapsed} />
        <button type="button" className="cp-sbtn side-toggle" data-tip={collapsed && !drawer ? "Expand sidebar" : undefined} title={collapsed ? undefined : drawer ? "Close navigation" : "Collapse sidebar"} aria-label={drawer ? "Close navigation" : `${collapsed ? "Expand" : "Collapse"} sidebar`} onClick={onCollapse}>
          <Icon name={collapsed ? "panelOpen" : "panelClose"} />
        </button>
      </div>
    </aside>
  );
}
