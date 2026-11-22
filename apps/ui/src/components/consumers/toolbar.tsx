"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { type ConsumersQuery, MAX_TEXT, consumersHref } from "@/lib/consumers";
import { LIVE_INTERVAL_MS } from "@/lib/traffic";
import { Icon } from "../icons";
import { Tip } from "../explore/tip";
import "../explore/explore.css";

const SIDE_KEY = "apilens.consumers.facets.hidden";
/** At and under this width the shell's menu is a drawer (Explore's DRAWER_AT). */
const NARROW = "(max-width: 860px)";

/**
 * The Consumers toolbar, Traffic's: the sidebar toggle, the filters in force as pills (Environment,
 * Group, Username contains), a username search (Enter; `/` focuses it), then Refresh (⇧R) and
 * Live (⌘J, a fresh read every 30 s while the tab is visible).
 */
export function ConsumersToolbar({ project, query: q }: { project: string; query: ConsumersQuery }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(q.q);
  const [live, setLive] = useState(true);
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  const refresh = () => startTransition(() => router.refresh());
  const go = (patch: Partial<ConsumersQuery>) => router.push(consumersHref(project, { ...q, consumer: null, ...patch }), { scroll: false });

  useEffect(() => setText(q.q), [q.q]);

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

  // ⌘J toggles Live, ⇧R refreshes, `/` focuses the search; not while typing.
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
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
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

  const pills: { key: string; field: string; value: string; clear: Partial<ConsumersQuery> }[] = [
    ...(q.env ? [{ key: "env", field: "Environment", value: q.env, clear: { env: "" } }] : []),
    ...(q.group ? [{ key: "group", field: "Group", value: q.group, clear: { group: null } }] : []),
    ...(q.q && q.by !== "anonymous" ? [{ key: "q", field: q.by === "groups" ? "Group" : "Username", value: q.q, clear: { q: "" } }] : []),
  ];

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
        <div className="exp tr-fbar">
          {pills.length ? (
            <ul className="exp-pills" aria-label="Active filters">
              {pills.map((p) => (
                <li key={p.key} className="exp-pill">
                  <span className="exp-pill__body">
                    <span className="exp-pill__field">{p.field}</span>
                    <span className="exp-pill__op">{p.key === "q" ? "contains" : "="}</span>
                    <span className={`exp-pill__value${p.key === "q" ? " is-mono" : ""}`}>{p.value}</span>
                  </span>
                  <Tip label="Remove filter">
                    <Link className="exp-pill__x" href={consumersHref(project, { ...q, consumer: null, ...p.clear })} scroll={false} prefetch={false} aria-label={`Remove filter: ${p.field} ${p.value}`}>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </Link>
                  </Tip>
                </li>
              ))}
            </ul>
          ) : null}
          {q.by === "anonymous" ? null : (
            <form
              className="exp-field"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                go({ q: text.trim() });
              }}
            >
              <input
                ref={input}
                className="exp-input"
                type="search"
                aria-label={q.by === "groups" ? "Search groups" : "Search usernames"}
                aria-keyshortcuts="/"
                placeholder={q.by === "groups" ? "Search groups…" : "Search usernames…"}
                value={text}
                maxLength={MAX_TEXT}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && text) {
                    e.preventDefault();
                    setText(q.q);
                  }
                }}
              />
            </form>
          )}
          {pills.length ? (
            <Tip label="Clear all filters">
              <button type="button" className="exp-clear" onClick={() => go({ env: "", group: null, q: "" })}>
                Clear
              </button>
            </Tip>
          ) : null}
        </div>
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
