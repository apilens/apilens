"use client";

import { type KeyboardEvent, useRef } from "react";
import { APP_TABPANEL_ID, APP_TABS, type AppTab, appTabHref, appTabId } from "@/lib/resources";

/**
 * The app page's tabs (M7 #1128): Overview | Resources, kept in the URL (`?tab=resources`), so a
 * link opens the tab and the back button returns. Each tab is a link: Tab focuses the selected one,
 * the arrow keys (and Home/End) move between them and Enter or Space opens the focused one
 * (manual activation, as every tab is a page load).
 */
export function AppTabs({ project, app, tab }: { project: string; app: string; tab: AppTab }) {
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = refs.current.findIndex((el) => el === document.activeElement);
    if (at < 0) return;
    const n = APP_TABS.length;
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (at + 1) % n;
    else if (e.key === "ArrowLeft") to = (at - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    else if (e.key === " ") {
      e.preventDefault();
      refs.current[at]?.click();
      return;
    }
    if (to === null) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  return (
    <div className="ap-tabs" role="tablist" aria-label="App views" onKeyDown={onKeyDown}>
      {APP_TABS.map((t, i) => (
        <a
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={appTabId(t.id)}
          role="tab"
          href={appTabHref(project, app, t.id)}
          aria-selected={t.id === tab}
          aria-controls={APP_TABPANEL_ID}
          tabIndex={t.id === tab ? 0 : -1}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}
