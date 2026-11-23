"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { INCIDENTS_OPEN, badgeText } from "@/lib/alerts";
import type { User } from "@/lib/identity";
import { LINKS } from "@/lib/links";
import { sidebarHref } from "@/lib/nav-scope";
import type { ContextOrg, ContextProject } from "@/lib/scope";
import { Icon } from "../icons";
import { Logo } from "../logo";
import { UserMenu } from "../user-menu";
import { OrgSelector, ProjectSelector } from "./scope-selectors";

/** Supabase's breadcrumb divider (LayoutHeaderDivider.tsx): a 16px slash, stroke 1, before each crumb. */
function Slash() {
  return (
    <svg className="tb-slash" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" shapeRendering="geometricPrecision">
      <path d="M16 3.549L7.12 20.600" />
    </svg>
  );
}

/**
 * The top bar, Supabase style: home, then organization / project as switchable crumbs on the left
 * (each name links to its scope's home, its chevron switches); the scope search (⌘K), docs and your
 * account on the right. In account scope there is no organization crumb, only home / `accountLabel`
 * (Account settings, or Organizations), as Supabase's `/account/*` and `/organizations` (#1051);
 * in organization scope there is no project crumb and no page title. Below 860px (#998) the bar
 * also names the page (`label`, the nav label) and, when any are open, links the open incident
 * count to Incidents keeping the current scope.
 */
export function TopBar({
  user,
  orgs,
  org,
  project,
  view,
  orgScope,
  account,
  accountLabel = "Account settings",
  label,
  openIncidents,
  onMenu,
  onSearch,
}: {
  user: User;
  orgs: ContextOrg[];
  org: ContextOrg;
  project?: ContextProject;
  view: string;
  orgScope: boolean;
  account: boolean;
  accountLabel?: string;
  label: string;
  openIncidents: number;
  /** Opens the phone drawer; without it (a page with no rail or menu) there is no menu button. */
  onMenu?: () => void;
  onSearch: () => void;
}) {
  const search = useSearchParams();
  // Incidents is coming soon: no open-incidents badge until it opens.
  const open = INCIDENTS_OPEN ? badgeText(openIncidents) : "";
  const scoped = project && !orgScope && !account ? project : undefined;
  return (
    <header className={`tb${onMenu ? "" : " tb--bare"}`} aria-label="Top bar">
      {onMenu ? (
        <button type="button" className="tb-icon tb-menu" aria-label="Open navigation" onClick={onMenu}>
          <Icon name="menu" />
        </button>
      ) : null}
      <Link href="/" className="tb-home" aria-label="APILens home">
        <Logo variant="icon" />
      </Link>
      <nav className="tb-crumbs" aria-label="Scope">
        {account ? null : (
          <span className="tb-crumb tb-crumb--org">
            <Slash />
            <OrgSelector orgs={orgs} org={org} />
          </span>
        )}
        {account && accountLabel ? (
          <span className="tb-crumb tb-crumb--account">
            <Slash />
            <span className="tb-here">{accountLabel}</span>
          </span>
        ) : project && !orgScope && !account ? (
          <span className="tb-crumb tb-crumb--project">
            <Slash />
            <ProjectSelector org={org} project={project} view={view} />
          </span>
        ) : null}
        {label && !account ? (
          <span className="tb-crumb tb-crumb--view">
            <Slash />
            <span className="tb-here">{label}</span>
          </span>
        ) : null}
      </nav>
      {scoped && open ? (
        <Link className="tb-incidents" href={sidebarHref(scoped.slug, "incidents", search)} aria-label={`${open} open ${open === "1" ? "incident" : "incidents"}`}>
          {open}
        </Link>
      ) : null}

      <div className="tb-right">
        <button type="button" className="tb-search" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" />
          <span>Search...</span>
          <kbd>⌘K</kbd>
        </button>
        <a className="tb-icon" href={LINKS.docs} target="_blank" rel="noreferrer" aria-label="Documentation" data-tip="Docs">
          <Icon name="help" />
        </a>
        <UserMenu user={user} current={account} placement="top" />
      </div>
    </header>
  );
}
