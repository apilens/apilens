"use client";

import { type FocusEvent, type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HoverLayout, indexAt, keepIndex, moveIndex } from "@/lib/chart-hover";

export interface ChartHover<T extends HTMLElement> {
  /** Attach to the plot box (the element the pointer moves over; position: relative). */
  ref: React.RefObject<T | null>;
  /** The point shown, or null. Already clamped to the data, so it survives live polling. */
  index: number | null;
  /** The plot box's measured width in CSS px (0 until measured): position the tooltip with it. */
  width: number;
  /** Spread on the plot box: pointer, touch, keyboard and focus handling. */
  bind: {
    tabIndex: 0;
    onPointerMove: (e: PointerEvent<T>) => void;
    onPointerDown: (e: PointerEvent<T>) => void;
    onPointerLeave: (e: PointerEvent<T>) => void;
    onKeyDown: (e: KeyboardEvent<T>) => void;
    onFocus: (e: FocusEvent<T>) => void;
    onBlur: () => void;
  };
  /** Hide the tooltip. */
  clear: () => void;
}

/**
 * Hover state for one chart: which point the reader is on, from the mouse (nearest point or the
 * bar under it), touch (a tap shows the point and keeps it until a tap elsewhere; a horizontal drag
 * scrubs) or the keyboard (focus the plot, arrows step, Home/End jump, Escape hides). `count` is
 * the number of points (bars or line vertices) and `layout` how they are spread across the width:
 * "slot" for bars, "point" for lines and sparklines (see lib/chart-hover).
 *
 *   const hover = useChartHover<HTMLDivElement>(rows.length, "slot");
 *   <div className="ct-box" ref={hover.ref} {...hover.bind} role="group" aria-label="…">
 *     <svg>…</svg>
 *     {hover.index !== null ? <ChartTooltip x={pointX(hover.index, hover.width, rows.length, "slot")} boxWidth={hover.width} … /> : null}
 *   </div>
 *   <ChartAnnounce text={hover.index !== null ? tooltipText(title, rows) : ""} />
 */
export function useChartHover<T extends HTMLElement = HTMLDivElement>(count: number, layout: HoverLayout = "point"): ChartHover<T> {
  const ref = useRef<T>(null);
  const [raw, setRaw] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  /** A touch tap pinned the tooltip: pointer leave does not clear it, a tap outside does. */
  const pinned = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clear = useCallback(() => {
    pinned.current = false;
    setRaw(null);
  }, []);

  // A tap anywhere else dismisses a pinned (touch) tooltip.
  useEffect(() => {
    if (raw === null) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (pinned.current && ref.current && !ref.current.contains(e.target as Node)) clear();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [raw, clear]);

  const at = (e: PointerEvent<T>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return indexAt(e.clientX - r.left, r.width, count, layout);
  };

  const bind: ChartHover<T>["bind"] = {
    tabIndex: 0,
    onPointerMove: (e) => {
      if (e.pointerType === "touch" && !pinned.current) return;
      setRaw(at(e));
    },
    onPointerDown: (e) => {
      if (e.pointerType === "mouse") return;
      pinned.current = true;
      setRaw(at(e));
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "mouse" && !pinned.current && document.activeElement !== e.currentTarget) setRaw(null);
    },
    onKeyDown: (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (raw !== null) {
          e.preventDefault();
          clear();
        }
        return;
      }
      const next = moveIndex(e.key, keepIndex(raw, count), count);
      if (next === null) return;
      e.preventDefault();
      setRaw(next);
    },
    onFocus: (e) => {
      // Keyboard focus shows the latest point; a click's focus leaves the pointer in charge.
      let keyboard = true;
      try {
        keyboard = e.currentTarget.matches(":focus-visible");
      } catch {}
      if (keyboard && count > 0) setRaw((r) => r ?? count - 1);
    },
    onBlur: clear,
  };

  return { ref, index: keepIndex(raw, count), width, bind, clear };
}
