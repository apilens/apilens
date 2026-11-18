"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CapabilitiesProvider } from "@/lib/permissions";
import { type UserContext, findOrg, findProject } from "@/lib/scope";
import { resolveTimeZone } from "@/lib/time-zone";
import { TimeZoneProvider } from "@/lib/time-zone-context";
import { PausedBanner } from "./paused-banner";
import { ScopeSwitcher } from "./scope-switcher";
import { Rail, useRailMode } from "./shell/rail";
import { TopBar } from "./shell/top-bar";
import "./shell/shell.css";

/**
 * Supabase-style chrome: a top bar with home / organization / project as switchable crumbs, the
 * scope search and your account; under it an icon rail of the project's pages and the page.
 * The rail is expanded, collapsed or expands on hover (the sidebar control at its foot, remembered;
 * `[` flips expanded and collapsed). Below 860px the rail is a drawer opened from the top bar.
 * ⌘K opens the scope switcher. `context` is the signed-in user's `GET /users/me/context`; the page
 * has already checked that `project` or `org` is in it. `account` is the account scope
 * (`/settings/*`): no project, the first organization in the crumbs. The page renders inside
 * `CapabilitiesProvider` with the actions the context allows on the project in scope (in org
 * scope, the org's first project; none in account scope), so `useCan`/`<Gated>` work below it,
 * and inside `TimeZoneProvider` with the user's time zone, so `useTimeZone` works too.
 */
export function AppShell({ context, project: projectSlug, org: orgSlug, account = false, view, children }: { context: UserContext; project?: string; org?: string; account?: boolean; view: string; children?: ReactNode }) {
  const found = projectSlug ? findProject(context, projectSlug) : undefined;
  const project = found?.project;
  const org = found?.org ?? findOrg(context, orgSlug ?? "") ?? context.orgs[0];
  // Org scope keeps the project nav, pointed at the org's first project (when it has one).
  const navProject = project ?? org.projects[0];
  const [mode, setMode] = useRailMode();
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => setDrawer(false), [navProject?.slug, view]);

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
        <TopBar user={context.user} orgs={context.orgs} org={org} project={navProject} view={view} orgScope={!project} account={account} onMenu={() => setDrawer(true)} onSearch={() => setSwitcher(true)} />
        <div className="shell-body">
          <div className="shell-rail">
            <Rail project={navProject} view={project ? view : ""} orgScope={!project} mode={mode} onMode={setMode} drawer={drawer} />
          </div>
          <div className="shell-scrim" onClick={() => setDrawer(false)} />
          <main className="app-main">
            <CapabilitiesProvider capabilities={context.capabilities} project={account ? undefined : navProject?.slug}>
              {project ? <PausedBanner project={project.slug} /> : null}
              {children}
            </CapabilitiesProvider>
          </main>
        </div>

        <ScopeSwitcher orgs={context.orgs} open={switcher} onClose={() => setSwitcher(false)} orgSlug={org.slug} projectSlug={navProject?.slug} />
      </div>
    </TimeZoneProvider>
  );
}
