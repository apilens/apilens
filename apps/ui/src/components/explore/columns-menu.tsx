"use client";

import { type DragEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { type ColumnId, type ColumnPrefs, DEFAULT_PREFS, columnDef, isShown, moveColumn } from "@/lib/explore-columns";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";

/** Columns that never hide: the table always has a time and a path. */
const FIXED: ReadonlySet<ColumnId> = new Set(["time", "path"]);

/**
 * The Columns menu (#1052, after Supabase's column picker): show or hide each column, find one by
 * name, drag a column (or Alt+↑/↓) to reorder, Reset columns (⌘U). Remembered in this browser.
 * A column that hides itself because the loaded rows leave it empty says so.
 */
export function ColumnsMenu({ prefs, auto, onPrefs }: { prefs: ColumnPrefs; auto: ReadonlySet<ColumnId>; onPrefs: (p: ColumnPrefs) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState<ColumnId | null>(null);

  const list = prefs.order.filter((c) => columnDef(c).label.toLowerCase().includes(search.trim().toLowerCase()));
  const move = (c: ColumnId, to: number) => onPrefs({ ...prefs, order: moveColumn(prefs.order, c, to) });

  const onDrop = (e: DragEvent<HTMLLIElement>, target: ColumnId) => {
    e.preventDefault();
    if (dragging && dragging !== target) move(dragging, prefs.order.indexOf(target));
    setDragging(null);
  };
  const onKey = (e: KeyboardEvent<HTMLLIElement>, c: ColumnId) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    move(c, prefs.order.indexOf(c) + (e.key === "ArrowUp" ? -1 : 1));
  };

  return (
    <>
      {/* DataTableViewOptions.tsx:41-48: a tiny 26px icon-only button, Settings2 (the sliders). */}
      <button
        ref={trigger}
        type="button"
        className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn ex-tbtn--icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Columns"
        title="Columns (⌘U resets)"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="sliders" />
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Columns" role="dialog" id={`${id}-pop`} align="end">
        <div className="exm-cols">
          <input
            type="search"
            className="exf-search"
            aria-label="Find a column"
            placeholder="Find a column…"
            value={search}
            autoComplete="off"
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="exm-cols__list" aria-label="Columns, drag or Alt+arrow keys to reorder">
            {list.map((c) => {
              const def = columnDef(c);
              const fixed = FIXED.has(c);
              const on = fixed || isShown(prefs, auto, c);
              const index = prefs.order.indexOf(c);
              return (
                <li
                  key={c}
                  className={`exm-cols__item${dragging === c ? " is-dragging" : ""}`}
                  draggable={!search}
                  onDragStart={(e) => {
                    setDragging(c);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", c);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, c)}
                  onDragEnd={() => setDragging(null)}
                  onKeyDown={(e) => onKey(e, c)}
                  data-column={c}
                >
                  <span className="exm-cols__grip" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <label className="exm-cols__label">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={fixed}
                      onChange={(e) => onPrefs({ ...prefs, shown: { ...prefs.shown, [c]: e.target.checked } })}
                    />
                    {def.label}
                    {!fixed && prefs.shown[c] === undefined && auto.has(c) ? <span className="exm-cols__note">empty, hidden</span> : null}
                  </label>
                  <span className="exm-cols__move">
                    <button type="button" aria-label={`Move ${def.label} up`} disabled={index === 0} onClick={() => move(c, index - 1)}>
                      ↑
                    </button>
                    <button type="button" aria-label={`Move ${def.label} down`} disabled={index === prefs.order.length - 1} onClick={() => move(c, index + 1)}>
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="ex-views__actions">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => onPrefs(DEFAULT_PREFS)} title="⌘U">
              Reset columns
            </button>
          </div>
        </div>
      </PopMenu>
    </>
  );
}
