"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CapabilitiesProvider } from "@/lib/permissions";
import { lastOrg } from "@/lib/landing";
import { type UserContext, findOrg, findProject } from "@/lib/scope";
import { viewLabel } from "@/lib/nav-sections";
import { resolveTimeZone } from "@/lib/time-zone";
import { TimeZoneProvider } from "@/lib/time-zone-context";
import { PausedBanner } from "./paused-banner";
import { ScopeSwitcher } from "./scope-switcher";
import { useOpenIncidents } from "./sidebar";
import { Rail, useRailMode } from "./shell/rail";
import { OpenIncidentsContext } from "./shell/shell-context";
import { hadPanel, notePanel, panelWidth } from "./shell/side-panel";
import { TopBar } from "./shell/top-bar";
import "./shell/shell.css";

/**
 * Supabase-style chrome: a top bar with home / organization / project as switchable crumbs, the
 * scope search and your account; under it an icon rail and the page. The rail lists the project's
 * pages in project scope (`project`), and the organization's (Projects, Team, Organization
 * settings) in organization scope (`org`, where `view` is the org page's section). Account scope
 * (`account`: `/settings/*` and `/organizations`) has no rail and no organization crumb (#1051).
 * The rail is expanded, collapsed or expands on hover (the sidebar control at its foot, remembered;
 * `[` flips expanded and collapsed). Below 860px the rail is a drawer opened from the top bar, and
 * the bar also names the page and the open incidents (#998).
 * ⌘K opens the scope switcher. `context` is the signed-in user's `GET /users/me/context`; the page
 * has already checked that `project` or `org` is in it. The page renders inside
 * `CapabilitiesProvider` with the actions the context allows on the project in scope (in org
 * scope, the org's first project; none in account scope), so `useCan`/`<Gated>` work below it,
 * and inside `TimeZoneProvider` with the user's time zone, so `useTimeZone` works too.
 *
 * `menu` is the section's secondary sidebar (#1051, a SectionMenu) between the rail and the
 * content pane; below 860px it moves into the drawer, under the rail links. A section renders the
 * shell from its `layout.tsx` with its menu, so neither remounts between its sub-pages; a page
 * without sub-pages renders the shell itself, without one. The top bar, the rail and the menu
 * never scroll: only the content pane (`main`) does.
 */
export function AppShell({
  context,
  project: projectSlug,
  org: orgSlug,
  account = false,
  view,
  menu,
  children,
}: {
  context: UserContext;
  project?: string;
  org?: string;
  account?: boolean;
  view: string;
  menu?: ReactNode;
  children?: ReactNode;
}) {
  const found = projectSlug ? findProject(context, projectSlug) : undefined;
  const project = found?.project;
  const org = found?.org ?? findOrg(context, orgSlug ?? "") ?? lastOrg(context) ?? context.orgs[0];
  // Capabilities in org scope are the org's first project's (none in account scope).
  const capsProject = project ?? org.projects[0];
  const orgScope = !project && !account;
  // Account scope has no rail, as Supabase's `/account/*` and `/organizations` (useHideSidebar):
  // account settings keep only their section menu, and `/organizations` has no side at all (and
  // so no phone menu button either).
  const sideless = account && !menu;
  const path = usePathname() ?? "";
  const [mode, setMode] = useRailMode();
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  // Asked again on every page, as when each page had its own shell.
  const openIncidents = useOpenIncidents(project?.slug, path || view);
  // Leaving a section with a menu for a page without one: the menu's width folds to 0 once (120ms).
  const [exit, setExit] = useState(() => (!menu && hadPanel() === true ? panelWidth() : 0));

  useEffect(() => setDrawer(false), [project?.slug, org.slug, view, path]);
  useEffect(() => notePanel(Boolean(menu)), [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((s) => !s);
      } else if (e.key === "[" && !typing && !mod) setMode(mode === "expanded" ? "collapsed" : "expanded");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, setMode]);

  return (
    <TimeZoneProvider timeZone={resolveTimeZone(context.user.preferences)}>
      <OpenIncidentsContext.Provider value={openIncidents}>
        <div className={`ah shell${drawer ? " is-open" : ""}`}>
          <TopBar
            user={context.user}
            orgs={context.orgs}
            org={org}
            project={project}
            view={view}
            orgScope={orgScope}
            account={account}
            accountLabel={view === "organizations" ? "Organizations" : undefined}
            label={viewLabel(view, { orgScope, account })}
            openIncidents={openIncidents}
            onMenu={sideless ? undefined : () => setDrawer(true)}
            onSearch={() => setSwitcher(true)}
          />
          <div className="shell-body">
            {sideless ? null : (
              <div className={`shell-side${menu ? " has-menu" : ""}${account ? " no-rail" : ""}`}>
                {account ? null : (
                  <div className="shell-rail">
                    <Rail project={project} org={org} view={project ? view : ""} orgSection={orgScope ? view : null} openIncidents={openIncidents} mode={mode} onMode={setMode} drawer={drawer} />
                  </div>
                )}
                {menu ? <div className="shell-menu">{menu}</div> : null}
              </div>
            )}
            {exit ? <div className="shell-menu-exit" style={{ width: exit }} aria-hidden="true" onAnimationEnd={() => setExit(0)} /> : null}
            <div className="shell-scrim" onClick={() => setDrawer(false)} />
            <main className="app-main">
              <CapabilitiesProvider capabilities={context.capabilities} project={account ? undefined : capsProject?.slug}>
                {project ? <PausedBanner project={project.slug} /> : null}
                {children}
              </CapabilitiesProvider>
            </main>
          </div>

          <ScopeSwitcher orgs={context.orgs} open={switcher} onClose={() => setSwitcher(false)} orgSlug={org.slug} projectSlug={capsProject?.slug} />
        </div>
      </OpenIncidentsContext.Provider>
    </TimeZoneProvider>
  );
}
