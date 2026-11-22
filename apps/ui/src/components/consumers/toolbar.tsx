"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ConsumersQuery } from "@/lib/consumers";
import { LIVE_INTERVAL_MS } from "@/lib/traffic";
import { Icon } from "../icons";
import { Tip } from "../explore/tip";
import { type BarOption, ConsumersFilterBar } from "./filter-bar";
import "../explore/explore.css";

const SIDE_KEY = "apilens.consumers.facets.hidden";
/** At and under this width the shell's menu is a drawer (Explore's DRAWER_AT). */
const NARROW = "(max-width: 860px)";

/**
 * The Consumers toolbar, Traffic's: the sidebar toggle, the filter bar (fields, then their values;
 * ConsumersFilterBar), then Refresh (⇧R) and Live (⌘J, a fresh read every 30 s while the tab is
 * visible).
 */
export function ConsumersToolbar({
  project,
  query: q,
  values,
  users,
}: {
  project: string;
  query: ConsumersQuery;
  values: Record<"env" | "group" | "app" | "method" | "path" | "status", BarOption[]>;
  users: { id: string; label: string; group: string }[];
}) {
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  const refresh = () => startTransition(() => router.refresh());

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, LIVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [live, router]);

  // While a refresh is in flight the data dims, as on Explore and Traffic.
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".page.cs");
    if (!page) return;
    if (pending) page.setAttribute("data-pending", "");
    else page.removeAttribute("data-pending");
  }, [pending]);

  // ⌘J toggles Live and ⇧R refreshes; not while typing.
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

  // The sidebar toggle folds the shell's menu away (remembered), or opens its drawer when narrow.
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

  return (
    <div className="tr-tools" role="toolbar" aria-label="Consumers">
      <div className="exr-side">
        <Tip label={hidden ? "Show filters" : "Hide filters"}>
          <button type="button" className="exr-sidebtn" aria-label={hidden ? "Show filters" : "Hide filters"} aria-expanded={!hidden} onClick={toggleSide}>
            <Icon name={hidden ? "panelOpen" : "panelClose"} />
          </button>
        </Tip>
      </div>
      <div className="tr-tools__scope">
        <ConsumersFilterBar project={project} query={q} values={values} users={users} />
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
