"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { badgeText } from "@/lib/alerts";
import { PROJECT_SETTINGS, VIEWS } from "@/lib/data";
import type { ContextProject } from "@/lib/scope";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import { RailIcon, type RailIconName } from "./rail-icons";

/** Supabase's sidebar behaviours: always open, icons only, or icons that open while hovered. */
export type RailMode = "expanded" | "collapsed" | "hover";

const MODES: { value: RailMode; label: string }[] = [
  { value: "expanded", label: "Expanded" },
  { value: "collapsed", label: "Collapsed" },
  { value: "hover", label: "Expand on hover" },
];

const KEY = "apilens.sidebar.mode";

/** The remembered mode (expand on hover until the user picks one), and a setter that remembers. */
export function useRailMode(): [RailMode, (m: RailMode) => void] {
  const [mode, setMode] = useState<RailMode>("hover");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "expanded" || saved === "collapsed" || saved === "hover") setMode(saved);
    } catch {}
  }, []);
  const set = (m: RailMode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {}
  };
  return [mode, set];
}

/**
 * The left rail, Supabase style: one icon per page in groups split by a rule (monitor, catalog,
 * configure), with the sidebar control at the foot. Labels show when expanded, while hovered in
 * "Expand on hover", and always in the mobile drawer.
 */
export function Rail({ project, view, orgScope, mode, onMode, drawer }: { project?: ContextProject; view: string; orgScope: boolean; mode: RailMode; onMode: (m: RailMode) => void; drawer: boolean }) {
  const open = badgeText(useOpenIncidents(project?.slug, view));
  const [control, setControl] = useState(false);
  const controlRef = useRef<HTMLButtonElement>(null);
  const tips = mode !== "expanded" && !drawer;

  const item = (p: ContextProject, slug: string, label: string, icon: RailIconName, badge?: string) => {
    const on = !orgScope && view === slug;
    return (
      <Link key={slug} href={`/${p.slug}/${slug}`} className={`rl-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} data-tip={tips && mode === "collapsed" ? label : undefined}>
        <span className="rl-ic">
          <RailIcon name={icon} />
          {badge ? <i className="rl-dot" aria-hidden="true" /> : null}
        </span>
        <span className="rl-lb">{label}</span>
        {badge ? (
          <span className="rl-ct" title={`${badge} open ${badge === "1" ? "incident" : "incidents"}`}>
            {badge}
          </span>
        ) : null}
      </Link>
    );
  };

  const group = (section: string) =>
    project
      ? VIEWS.filter((v) => v.section === section).map((v) => item(project, v.slug, v.label, v.slug as RailIconName, v.slug === "incidents" && open ? open : undefined))
      : null;

  return (
    <aside className={`rl rl--${drawer ? "drawer" : mode}`} aria-label="Sidebar">
      <div className="rl-panel">
        <nav className="rl-nav" aria-label="Pages">
          {project ? (
            <>
              <div className="rl-group">{group("Monitor")}</div>
              <hr className="rl-sep" />
              <div className="rl-group">{group("Catalog")}</div>
              <hr className="rl-sep" />
              <div className="rl-group">
                {group("Configure")}
                {item(project, PROJECT_SETTINGS.slug, PROJECT_SETTINGS.label, "settings")}
              </div>
            </>
          ) : null}
        </nav>
        {drawer ? null : (
          <div className="rl-foot">
            <button ref={controlRef} type="button" className={`rl-item rl-control${control ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={control} aria-label="Sidebar control" data-tip={tips && mode === "collapsed" && !control ? "Sidebar control" : undefined} onClick={() => setControl((c) => !c)}>
              <span className="rl-ic">
                <RailIcon name="panel" />
              </span>
              <span className="rl-lb">Sidebar control</span>
            </button>
            <PopMenu open={control} onClose={() => setControl(false)} triggerRef={controlRef} label="Sidebar control" align="side-up">
              <p className="menu-label">Sidebar control</p>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === m.value}
                  className="cp-sitem"
                  onClick={() => {
                    onMode(m.value);
                    setControl(false);
                  }}
                >
                  <span className="lb">{m.label}</span>
                  {mode === m.value ? (
                    <span className="sl">
                      <Icon name="check" />
                    </span>
                  ) : null}
                </button>
              ))}
            </PopMenu>
          </div>
        )}
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
