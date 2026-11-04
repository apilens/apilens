"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { firstProjectOf, orgBySlug, orgOf, projectBySlug } from "@/lib/data";
import { Icon } from "./icons";
import { ScopeSwitcher } from "./scope-switcher";
import { Sidebar } from "./sidebar";

/**
 * One sidebar (organization, project, pages, account) and the page. No top bar on desktop; below
 * 860px a slim bar with the menu button opens the sidebar as a drawer. `[` collapses the sidebar
 * to a rail (remembered). ⌘K opens the scope switcher.
 */
export function AppShell({ project: projectSlug, org: orgSlug, view, children }: { project?: string; org?: string; view: string; children?: ReactNode }) {
  const project = projectSlug ? projectBySlug(projectSlug)! : undefined;
  const org = project ? orgOf(project) : orgBySlug(orgSlug!);
  const navProject = project ?? firstProjectOf(org.slug);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [switcher, setSwitcher] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("apilens.sidebar") === "1");
    } catch {}
  }, []);
  useEffect(() => setDrawer(false), [navProject.slug, view]);

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
        <Sidebar org={org} project={navProject} view={project ? view : ""} orgScope={!project} collapsed={collapsed && !drawer} drawer={drawer} onCollapse={drawer ? () => setDrawer(false) : toggle} />
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

      <ScopeSwitcher open={switcher} onClose={() => setSwitcher(false)} orgSlug={org.slug} projectSlug={navProject.slug} />
    </div>
  );
}
