"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { RANGE_LABEL } from "@/lib/consumers";
import type { NamedApp } from "@/lib/identity";
import { LIVE_INTERVAL_MS, TRAFFIC_RANGES, type TrafficState, appName, appOptions, trafficHref } from "@/lib/traffic";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import { Tip } from "../explore/tip";
import "../explore/explore.css";

/**
 * Traffic's toolbar, built from Explore's (same 48px full-width row, pills, 26px buttons and
 * tooltips), so the two pages read as one product: the page's name, then its scope as pills
 * (time range, environment and, with several apps, the app), each opening a menu of links; at the
 * end Refresh (⇧R) and Live (⌘J), which reads the page again every 30 s while the tab is visible.
 */
export function TrafficToolbar({ project, query: q, environments, apps }: { project: string; query: TrafficState; environments: readonly string[]; apps: NamedApp[] | null }) {
  const router = useRouter();
  const [live, setLive] = useState(true);
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

  // A link the project no longer lists (a shared URL) stays selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;

  return (
    <div className="tr-tools" role="toolbar" aria-label="Traffic">
      <h1 className="tr-tools__title">Traffic</h1>
      <div className="tr-tools__scope">
        <ScopePill
          label="Time range"
          icon
          value={`Last ${RANGE_LABEL[q.range]}`}
          options={TRAFFIC_RANGES.map((r) => ({ key: r, label: `Last ${RANGE_LABEL[r]}`, href: trafficHref(project, { ...q, range: r }), on: r === q.range }))}
        />
        <ScopePill
          label="Environment"
          value={q.env || "All"}
          options={[
            { key: "", label: "All environments", href: trafficHref(project, { ...q, env: "" }), on: !q.env },
            ...envs.map((env) => ({ key: env, label: env, href: trafficHref(project, { ...q, env }), on: env === q.env })),
          ]}
        />
        {apps && (apps.length > 1 || q.app) ? (
          <ScopePill
            label="App"
            value={q.app ? appName(apps, q.app) : "All"}
            options={appOptions(apps, q.app).map((o) => ({ key: o.value, label: o.label, href: trafficHref(project, { ...q, app: o.value }), on: o.value === q.app }))}
          />
        ) : null}
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

/**
 * One scope as Explore's pill (`Environment = production ▾`): clicking opens a menu of the
 * choices, each a link (the current one checked), so the scope stays in the URL.
 */
function ScopePill({ label, value, options, icon = false }: { label: string; value: string; options: { key: string; label: string; href: string; on: boolean }[]; icon?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={trigger} type="button" className="exp-pill tr-pill" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}: ${value}`} onClick={() => setOpen((o) => !o)}>
        {icon ? (
          <span className="tr-pill__icon" aria-hidden="true">
            <Icon name="clock" />
          </span>
        ) : (
          <>
            <span className="exp-pill__field">{label}</span>
            <span className="exp-pill__op">=</span>
          </>
        )}
        <span className="exp-pill__value">{value}</span>
        <svg className="tr-pill__chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label={label} width={220}>
        {options.map((o) => (
          <a key={o.key || "all"} role="menuitemradio" aria-checked={o.on} className="cp-sitem" href={o.href} onClick={() => setOpen(false)}>
            <span className="lb">{o.label}</span>
            {o.on ? (
              <span className="tr-pill__check" aria-hidden="true">
                <Icon name="check" />
              </span>
            ) : null}
          </a>
        ))}
      </PopMenu>
    </>
  );
}
