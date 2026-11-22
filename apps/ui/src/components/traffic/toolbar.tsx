"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { NamedApp } from "@/lib/identity";
import { LIVE_INTERVAL_MS, type TrafficState } from "@/lib/traffic";
import { Icon } from "../icons";
import { Tip } from "../explore/tip";
import { TrafficColumnsMenu } from "./columns";
import { TrafficFilterBar } from "./filter-bar";
import "../explore/explore.css";

const SIDE_KEY = "apilens.traffic.facets.hidden";
/** At and under this width the shell's menu is a drawer (Explore's DRAWER_AT). */
const NARROW = "(max-width: 860px)";

/**
 * Traffic's toolbar, built from Explore's (same 48px full-width row, pills, 26px buttons and
 * tooltips), so the two pages read as one product: the sidebar toggle, the filter bar (environment, app, method,
 * endpoint; TrafficFilterBar), led by a Time range pill only off the default 24 hours, as in
 * Explore (the sidebar always holds the range); at the end Refresh (⇧R),
 * Columns (the endpoints table's) and Live (⌘J), which
 * reads the page again every 30 s while the tab is visible.
 */
export function TrafficToolbar({
  project,
  query: q,
  environments,
  apps,
  methods,
  paths,
  consumers = [],
}: {
  project: string;
  query: TrafficState;
  environments: readonly string[];
  apps: NamedApp[] | null;
  methods: { value: string; label: string; count?: number }[];
  paths: { value: string; label: string; count?: number }[];
  consumers?: { value: string; label: string; count?: number }[];
}) {
  const router = useRouter();
  // A picked window is a fixed past span: Live has nothing new to show there, so it starts paused.
  const [live, setLive] = useState(!(q.from && q.to));
  // Picking a window on the chart (a client navigation, this toolbar stays mounted) pauses Live;
  // leaving the window doesn't turn it back on by itself.
  const picked = Boolean(q.from && q.to);
  useEffect(() => {
    if (picked) setLive(false);
  }, [picked]);
  const [pending, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, LIVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [live, router]);

  // ⌘J toggles Live and ⇧R refreshes, as in Explore; not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setLive((l) => !l);
      } else if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === "R") {
        e.preventDefault();
        startTransition(() => router.refresh());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router]);

  // The sidebar toggle, Explore's: folds the shell's menu (the filters) away on wide screens,
  // remembered in this browser; where the menu is a drawer, it opens the drawer.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(SIDE_KEY) === "1");
    } catch {}
  }, []);
  useEffect(() => {
    const menu = document.querySelector<HTMLElement>(".shell-menu");
    if (!menu) return;
    if (hidden) menu.setAttribute("data-ex-hidden", "");
    else menu.removeAttribute("data-ex-hidden");
    return () => menu.removeAttribute("data-ex-hidden");
  }, [hidden]);
  const toggleSide = () => {
    if (window.matchMedia(NARROW).matches) {
      document.querySelector<HTMLButtonElement>(".tb-menu")?.click();
      return;
    }
    const next = !hidden;
    setHidden(next);
    try {
      window.localStorage.setItem(SIDE_KEY, next ? "1" : "0");
    } catch {}
  };

  // While a refresh is in flight the data under the toolbar dims, as Explore's (.exr-data.is-stale).
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".page.tr");
    if (!page) return;
    if (pending) page.setAttribute("data-pending", "");
    else page.removeAttribute("data-pending");
  }, [pending]);

  // A link the project no longer lists (a shared URL) stays selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;

  return (
    <div className="tr-tools" role="toolbar" aria-label="Traffic">
      <div className="exr-side">
        <Tip label={hidden ? "Show filters" : "Hide filters"}>
          <button type="button" className="exr-sidebtn" aria-label={hidden ? "Show filters" : "Hide filters"} aria-expanded={!hidden} onClick={toggleSide}>
            <Icon name={hidden ? "panelOpen" : "panelClose"} />
          </button>
        </Tip>
      </div>
      <div className="tr-tools__scope">
        <TrafficFilterBar project={project} query={q} environments={envs} apps={apps} methods={methods} paths={paths} consumers={consumers} />
      </div>
      <div className="tr-tools__end">
        <Tip label="Refresh" keys={["⇧", "R"]}>
          <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon" aria-label="Refresh" aria-keyshortcuts="Shift+R" disabled={pending} onClick={refresh}>
            {pending ? (
              <span className="ex-tbtn__spin">
                <Icon name="loader" />
              </span>
            ) : (
              <Icon name="refresh" />
            )}
          </button>
        </Tip>
        <TrafficColumnsMenu />
        <Tip label={live ? "Pause live updates" : "Start live updates (every 30 s)"} keys={["⌘", "J"]}>
          <button
            type="button"
            className={`ah-btn ah-btn--sm ex-tbtn exr-live${live ? " ah-btn--primary is-on" : " ah-btn--secondary"}`}
            aria-pressed={live}
            aria-keyshortcuts="Meta+J"
            onClick={() => setLive((l) => !l)}
          >
            <Icon name={live ? "circlePause" : "circlePlay"} />
            Live
          </button>
        </Tip>
      </div>
    </div>
  );
}
