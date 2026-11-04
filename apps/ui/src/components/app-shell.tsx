"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type UserContext, findOrg, findProject } from "@/lib/scope";
import { Icon } from "./icons";
import { ScopeSwitcher } from "./scope-switcher";
import { Sidebar } from "./sidebar";

/**
 * One sidebar (organization, project, pages, account) and the page. No top bar on desktop; below
 * 860px a slim bar with the menu button opens the sidebar as a drawer. `[` collapses the sidebar
 * to a rail (remembered). ⌘K opens the scope switcher. `context` is the signed-in user's
 * `GET /users/me/context`; the page has already checked that `project` or `org` is in it.
 * `account` is the account scope (`/settings/*`): no project, the first organization in the top
 * cell, and the account menu marks Account settings as the current page.
 */
export function AppShell({ context, project: projectSlug, org: orgSlug, account = false, view, children }: { context: UserContext; project?: string; org?: string; account?: boolean; view: string; children?: ReactNode }) {
  const found = projectSlug ? findProject(context, projectSlug) : undefined;
  const project = found?.project;
  const org = found?.org ?? findOrg(context, orgSlug ?? "") ?? context.orgs[0];
  // Org scope keeps the project nav, pointed at the org's first project (when it has one).
  const navProject = project ?? org.projects[0];
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("apilens.sidebar") === "1");
    } catch {}
  }, []);
  useEffect(() => setDrawer(false), [navProject?.slug, view]);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("apilens.sidebar", c ? "0" : "1");
      } catch {}
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((s) => !s);
      } else if (e.key === "[" && !typing && !mod) toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    <div className={`ah app${drawer ? " is-open" : ""}`}>
      <div className="app-side">
        <Sidebar user={context.user} orgs={context.orgs} org={org} project={navProject} view={project ? view : ""} orgScope={!project} account={account} collapsed={collapsed && !drawer} drawer={drawer} onCollapse={drawer ? () => setDrawer(false) : toggle} />
      </div>
      <div className="app-scrim" onClick={() => setDrawer(false)} />

      <div className="app-col">
        <div className="app-mobilebar">
          <button type="button" className="cp-sbtn" aria-label="Open navigation" onClick={() => setDrawer(true)}>
            <Icon name="menu" />
          </button>
        </div>
        <main className="app-main">{children}</main>
      </div>

      <ScopeSwitcher orgs={context.orgs} open={switcher} onClose={() => setSwitcher(false)} orgSlug={org.slug} projectSlug={navProject?.slug} />
    </div>
  );
}
