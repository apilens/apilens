"use client";

import Link from "next/link";
import type { User } from "@/lib/identity";
import { LINKS } from "@/lib/links";
import type { ContextOrg, ContextProject } from "@/lib/scope";
import { Icon } from "../icons";
import { Logo } from "../logo";
import { UserMenu } from "../user-menu";
import { OrgSelector, ProjectSelector } from "./scope-selectors";

/** Supabase's breadcrumb divider: a thin forward slash. */
function Slash() {
  return (
    <svg className="tb-slash" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 3.5 8 20.5" />
    </svg>
  );
}

/**
 * The top bar, Supabase style: home, then organization / project as switchable crumbs on the left;
 * the scope search (⌘K), docs and your account on the right. In account scope the last crumb is
 * Account settings; in organization scope there is no project crumb.
 */
export function TopBar({
  user,
  orgs,
  org,
  project,
  view,
  orgScope,
  account,
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
  onMenu: () => void;
  onSearch: () => void;
}) {
  return (
    <header className="tb" aria-label="Top bar">
      <button type="button" className="tb-icon tb-menu" aria-label="Open navigation" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <Link href="/" className="tb-home" aria-label="APILens home">
        <Logo variant="icon" />
      </Link>
      <nav className="tb-crumbs" aria-label="Scope">
        <Slash />
        <OrgSelector orgs={orgs} org={org} orgScope={orgScope} />
        {account ? (
          <>
            <Slash />
            <span className="tb-here">Account settings</span>
          </>
        ) : project && !orgScope ? (
          <>
            <Slash />
            <ProjectSelector org={org} project={project} view={view} />
          </>
        ) : null}
      </nav>

      <div className="tb-right">
        <button type="button" className="tb-search" onClick={onSearch} aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" />
          <span>Jump to…</span>
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
