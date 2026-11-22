"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
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
 * Group), a search that filters as you type and suggests the matching
 * usernames (opening their drawer), groups and environments (arrows, Enter, Esc; `/` focuses it),
 * then Refresh (⇧R) and Live (⌘J, a fresh read every 30 s while the tab is visible).
 */
export function ConsumersToolbar({
  project,
  query: q,
  users,
  groups,
  environments,
}: {
  project: string;
  query: ConsumersQuery;
  /** The usernames the list shows (already narrowed by what was typed), for suggestions. */
  users: { id: string; label: string; group: string }[];
  groups: { group: string; consumers: number }[];
  environments: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(q.q);
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(0);
  const [live, setLive] = useState(true);
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  const refresh = () => startTransition(() => router.refresh());
  const go = (patch: Partial<ConsumersQuery>) => router.push(consumersHref(project, { ...q, consumer: null, ...patch }), { scroll: false });

  useEffect(() => setText(q.q), [q.q]);

  // As you type, the list follows (after a short pause): the search is the page's `q`, so the
  // usernames suggested below are the ones that match.
  const searchable = q.by !== "anonymous";
  useEffect(() => {
    if (!searchable || text.trim() === q.q) return;
    const t = window.setTimeout(() => router.replace(consumersHref(project, { ...q, consumer: null, q: text.trim() }), { scroll: false }), 300);
    return () => window.clearTimeout(t);
  }, [text, q, project, router, searchable]);

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

  // The suggestions: what was typed as a search, then the matching usernames (open their drawer),
  // groups and environments; with nothing typed, the groups and environments to narrow to.
  type Option = { key: string; text: string; detail?: string; mono?: boolean; head?: boolean; run: () => void };
  const t = text.trim().toLowerCase();
  const noop = () => {};
  const matchedGroups = groups.filter((g) => !t || g.group.toLowerCase().includes(t)).slice(0, 6);
  const matchedEnvs = environments.filter((e) => !t || e.toLowerCase().includes(t)).slice(0, 4);
  const matchedUsers = t && q.by === "consumers" ? users.filter((u) => u.label.toLowerCase().includes(t) || u.id.toLowerCase().includes(t)).slice(0, 6) : [];
  const options: Option[] = [
    ...(t ? [{ key: "q", text: `${q.by === "groups" ? "Group" : "Username"} contains “${text.trim()}”`, detail: "search", run: () => go({ q: text.trim() }) }] : []),
    ...(matchedUsers.length ? [{ key: "h-users", text: "Usernames", head: true, run: noop }] : []),
    ...matchedUsers.map((u) => ({
      key: `u-${u.id}`,
      text: u.label,
      detail: u.group || undefined,
      mono: true,
      run: () => router.push(consumersHref(project, { ...q, q: text.trim(), consumer: u.id }), { scroll: false }),
    })),
    ...(q.by === "consumers" && matchedGroups.length ? [{ key: "h-groups", text: "Group", head: true, run: noop }] : []),
    ...(q.by === "consumers"
      ? matchedGroups.map((g) => ({ key: `g-${g.group}`, text: g.group, detail: `${g.consumers} users`, run: () => go({ group: g.group, q: "" }) }))
      : []),
    ...(matchedEnvs.length ? [{ key: "h-envs", text: "Environment", head: true, run: noop }] : []),
    ...matchedEnvs.map((e) => ({ key: `e-${e}`, text: e, detail: q.env === e ? "current" : undefined, run: () => go({ env: e, q: "" }) })),
  ];
  // Keyboard focus skips the section headings.
  const pickable = options.map((o, n) => (o.head ? -1 : n)).filter((n) => n >= 0);
  const at = pickable.includes(active) ? active : (pickable.find((n) => n >= active) ?? pickable[0] ?? 0);

  const pills: { key: string; field: string; value: string; clear: Partial<ConsumersQuery> }[] = [
    ...(q.env ? [{ key: "env", field: "Environment", value: q.env, clear: { env: "" } }] : []),
    ...(q.group ? [{ key: "group", field: "Group", value: q.group, clear: { group: null } }] : []),
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
                    <span className="exp-pill__op">=</span>
                    <span className="exp-pill__value">{p.value}</span>
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
          {searchable ? (
            <div className="exp-field">
              <input
                ref={input}
                className="exp-input"
                type="text"
                role="combobox"
                aria-label={q.by === "groups" ? "Search groups" : "Search usernames, groups, environments"}
                aria-expanded={menu && options.length > 0}
                aria-controls={`${id}-menu`}
                aria-autocomplete="list"
                aria-activedescendant={menu && options[at] ? `${id}-o-${at}` : undefined}
                aria-keyshortcuts="/"
                placeholder={q.by === "groups" ? "Search groups…" : "Search usernames, groups…"}
                value={text}
                maxLength={MAX_TEXT}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setText(e.target.value);
                  setActive(0);
                  setMenu(true);
                }}
                onFocus={() => setMenu(true)}
                onBlur={() => window.setTimeout(() => setMenu(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setMenu(true);
                    const k = pickable.indexOf(at);
                    const next = pickable[Math.max(0, Math.min(pickable.length - 1, k + (e.key === "ArrowDown" ? 1 : -1)))];
                    if (next !== undefined) setActive(next);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (options[at]) options[at].run();
                    else go({ q: text.trim() });
                    setMenu(false);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    if (menu) setMenu(false);
                    else if (text) setText("");
                    else input.current?.blur();
                  }
                }}
              />
              {menu && options.length > 0 ? (
                <ul className="exp-menu" id={`${id}-menu`} role="listbox" aria-label="Suggestions">
                  {options.map((o, n) =>
                    o.head ? (
                      <li key={o.key} className="exp-menu__head" role="presentation">
                        {o.text}
                      </li>
                    ) : (
                      <li
                        key={o.key}
                        id={`${id}-o-${n}`}
                        role="option"
                        aria-selected={n === at}
                        className={n === at ? "is-active" : undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseMove={() => n !== at && setActive(n)}
                        onClick={() => {
                          o.run();
                          setMenu(false);
                        }}
                      >
                        <span className={`exp-menu__text${o.mono ? " is-mono" : ""}`}>{o.text}</span>
                        {o.detail ? <span className="exp-menu__count">{o.detail}</span> : null}
                      </li>
                    ),
                  )}
                  <li className="exp-menu__keys" role="presentation" aria-hidden="true">
                    <span>
                      <kbd>↑</kbd>
                      <kbd>↓</kbd> move
                    </span>
                    <span>
                      <kbd>↵</kbd> pick
                    </span>
                    <span>
                      <kbd>esc</kbd> close
                    </span>
                  </li>
                </ul>
              ) : null}
            </div>
          ) : null}
          {/* The box's text is the search (it filters as you type), so a search is no pill; Clear clears it too. */}
          {pills.length || q.q ? (
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
