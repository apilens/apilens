"use client";

import { useEffect, useRef, useState } from "react";
import { TRAFFIC_HIDDEN_COLUMNS } from "@/lib/traffic";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";
import { Tip } from "../explore/tip";

/** The endpoints table's columns that can hide (Endpoint always shows), in table order. */
export const TRAFFIC_COLUMNS = [
  { id: "app", label: "App" },
  { id: "requests", label: "Requests" },
  { id: "client_errors", label: "4xx" },
  { id: "server_errors", label: "5xx" },
  { id: "p50", label: "p50" },
  { id: "p95", label: "p95" },
  { id: "apdex", label: "Apdex" },
  { id: "spent", label: "Time spent" },
] as const;
type ColumnId = (typeof TRAFFIC_COLUMNS)[number]["id"];

const DEFAULT_HIDDEN: readonly ColumnId[] = TRAFFIC_HIDDEN_COLUMNS;
// v2: the defaults changed (p50 and Time spent hidden), so older saved choices don't apply.
const KEY = "apilens.traffic.columns.hidden.v2";
const ATTR = "data-hide";

function readHidden(): ColumnId[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [...DEFAULT_HIDDEN];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is ColumnId => TRAFFIC_COLUMNS.some((c) => c.id === x)) : [];
  } catch {
    return [...DEFAULT_HIDDEN];
  }
}

/**
 * The Columns menu, Explore's (the 26px sliders button, a find box, a checkbox per column, Reset
 * columns ⌘U), for the endpoints table: show or hide each column, remembered in this browser.
 * p50 and Time spent start hidden (TRAFFIC_HIDDEN_COLUMNS); the page renders them hidden from the server.
 * The table stays server-rendered; hidden columns are named on the page (`data-hide`) and CSS
 * hides their cells.
 */
export function TrafficColumnsMenu() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<ColumnId[]>([...DEFAULT_HIDDEN]);

  useEffect(() => setHidden(readHidden()), []);
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".page.tr");
    if (!page) return;
    if (hidden.length) page.setAttribute(ATTR, hidden.join(" "));
    else page.removeAttribute(ATTR);
  }, [hidden]);

  const save = (next: ColumnId[]) => {
    setHidden(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  };

  // ⌘U resets the columns, as in Explore; not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "u") {
        e.preventDefault();
        save([...DEFAULT_HIDDEN]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const list = TRAFFIC_COLUMNS.filter((c) => c.label.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <>
      <Tip label="Columns">
        <button
          ref={trigger}
          type="button"
          className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Columns"
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="sliders" />
        </button>
      </Tip>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Columns" role="dialog" align="end">
        <div className="exm-cols">
          <input type="search" className="exf-search" aria-label="Find a column" placeholder="Find a column…" value={search} autoComplete="off" onChange={(e) => setSearch(e.target.value)} />
          <ul className="exm-cols__list" aria-label="Columns">
            <li className="exm-cols__item">
              <label className="exm-cols__label">
                <input type="checkbox" checked disabled />
                Endpoint
              </label>
            </li>
            {list.map((c) => (
              <li key={c.id} className="exm-cols__item">
                <label className="exm-cols__label">
                  <input
                    type="checkbox"
                    checked={!hidden.includes(c.id)}
                    onChange={(e) => save(e.target.checked ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])}
                  />
                  {c.label}
                </label>
              </li>
            ))}
          </ul>
          <div className="ex-views__actions">
            <Tip label="Reset columns" keys={["⌘", "U"]}>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" aria-keyshortcuts="Meta+U" onClick={() => save([...DEFAULT_HIDDEN])}>
                Reset columns
              </button>
            </Tip>
          </div>
        </div>
      </PopMenu>
    </>
  );
}
