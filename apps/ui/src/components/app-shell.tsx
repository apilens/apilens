"use client";

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
import { TopBar } from "./shell/top-bar";
import "./shell/shell.css";

/**
 * Supabase-style chrome: a top bar with home / organization / project as switchable crumbs, the
 * scope search and your account; under it an icon rail and the page. The rail lists the project's
 * pages in project scope (`project`), and the organization's (Projects, Team, Organization
 * settings) in organization scope (`org`, where `view` is the org page's section) and in account
 * scope (`account`: `/settings/*` and `/organizations`, the last project's organization).
 * The rail is expanded, collapsed or expands on hover (the sidebar control at its foot, remembered;
 * `[` flips expanded and collapsed). Below 860px the rail is a drawer opened from the top bar, and
 * the bar also names the page and the open incidents (#998).
 * ⌘K opens the scope switcher. `context` is the signed-in user's `GET /users/me/context`; the page
 * has already checked that `project` or `org` is in it. The page renders inside
 * `CapabilitiesProvider` with the actions the context allows on the project in scope (in org
 * scope, the org's first project; none in account scope), so `useCan`/`<Gated>` work below it,
 * and inside `TimeZoneProvider` with the user's time zone, so `useTimeZone` works too.
 */
export function AppShell({ context, project: projectSlug, org: orgSlug, account = false, view, children }: { context: UserContext; project?: string; org?: string; account?: boolean; view: string; children?: ReactNode }) {
  const found = projectSlug ? findProject(context, projectSlug) : undefined;
  const project = found?.project;
  const org = found?.org ?? findOrg(context, orgSlug ?? "") ?? lastOrg(context) ?? context.orgs[0];
  // Capabilities in org scope are the org's first project's (none in account scope).
  const capsProject = project ?? org.projects[0];
  const orgScope = !project && !account;
  const [mode, setMode] = useRailMode();
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const openIncidents = useOpenIncidents(project?.slug, view);

  useEffect(() => setDrawer(false), [project?.slug, org.slug, view]);

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
      <div className={`ah shell${drawer ? " is-open" : ""}`}>
        <TopBar
          user={context.user}
          orgs={context.orgs}
          org={org}
          project={project}
          view={view}
          orgScope={orgScope}
          account={account}
          accountLabel={view === "organizations" ? "" : undefined}
          label={viewLabel(view, { orgScope, account })}
          openIncidents={openIncidents}
          onMenu={() => setDrawer(true)}
          onSearch={() => setSwitcher(true)}
        />
        <div className="shell-body">
          <div className="shell-rail">
            <Rail project={project} org={org} view={project ? view : ""} orgSection={orgScope ? view : null} openIncidents={openIncidents} mode={mode} onMode={setMode} drawer={drawer} />
          </div>
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
    </TimeZoneProvider>
  );
}
