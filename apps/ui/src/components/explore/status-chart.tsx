"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { formatCount, niceMax } from "@/lib/consumers";
import { type ChartPeriod, bucketAt, bucketSpan, chartPeriod, chartTick, chartTickIndices, chartTooltipLabel, formatInstant, isoSecond, moveBucket, selectionWindow, windowText } from "@/lib/explore-timeline";
import type { RequestTimeline } from "@/lib/identity";
import { useTimeZone } from "@/lib/time-zone-context";

// Geometry copied from Supabase's TimelineChart (apps/studio/components/ui/DataTable/TimelineChart.tsx)
// and the recharts defaults it relies on:
// - ChartContainer `h-[60px] w-full px-2` (TimelineChart.tsx:101), margin 0 (:109);
// - XAxis without a height, so recharts' default 30px axis band under a 30px plot;
// - tickLine false, axisLine false (:134-136), labels 12px (`text-xs`, chart.tsx:53) at
//   tickSize 6 + tickMargin 2 below the plot, dy 0.71em;
// - Bar without barCategoryGap/radius: recharts' 10% gap each side of a band, square corners.
const H = 60;
const AXIS_H = 30;
const PLOT_H = H - AXIS_H;
const TICK_Y = PLOT_H + 6 + 2;
const GAP = 0.1;
/** Before the plot is measured (server render). */
const FALLBACK_W = 960;
/** Rough width of one 12px mono-ish character, to thin ticks as recharts measures them. */
const CHAR_PX = 7;

/** Bottom up, as the Bars are declared (TimelineChart.tsx:168-180): error, warning, success. */
const LAYERS = [
  { key: "server_errors", cls: "5xx", level: "Error", code: "5xx", className: "exc-5xx" },
  { key: "client_errors", cls: "4xx", level: "Warning", code: "4xx", className: "exc-4xx" },
  { key: "successful", cls: "2xx", level: "Success", code: "2–3xx", className: "exc-ok" },
] as const;

type Layer = (typeof LAYERS)[number]["cls"];

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Explore's chart, a copy of Supabase's TimelineChart (#1061): 60px in all, a 30px plot of
 * stacked bars (5xx red at the bottom, then 4xx amber, then the rest muted) over a 30px band of
 * time ticks, full width with 8px sides and no card. Hover shows the bucket under a muted cursor
 * with Supabase's tooltip; drag across bars, or click one, highlights a range and opens the
 * "Filter requests to selected range" menu where the drag started (`onRange`). Keyboard: arrows
 * pick a bar, Shift with them selects several, Enter opens the menu, Esc cancels.
 */
export function StatusChart({
  timeline,
  shown,
  onRange,
}: {
  timeline: RequestTimeline | null;
  shown: ReadonlySet<Layer>;
  onRange: (from: string, to: string) => void;
}) {
  const tz = useTimeZone();
  const id = useId();
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>();
  const w = measured ?? FALLBACK_W;
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [sel, setSel] = useState<{ a: number; b: number; done: boolean; at: { x: number; y: number } } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const drag = useRef<{ a: number; at: { x: number; y: number } } | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The menu closes on Esc and on a click outside it (ChartHighlightActions.tsx:104-111).
  useEffect(() => {
    if (!sel?.done) return;
    const onDown = (e: globalThis.PointerEvent) => {
      const t = e.target as Element | null;
      if (menu.current?.contains(t) || t?.closest?.(".exc-plot")) return;
      setSel(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setSel(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sel?.done]);

  if (timeline === null) {
    return (
      <div className="exc exc--error" role="status">
        Couldn’t load the chart just now. The requests below still work.
      </div>
    );
  }

  const buckets = timeline.buckets ?? [];
  const count = buckets.length;
  const layers = LAYERS.filter((l) => shown.has(l.cls));
  const slot = count ? w / count : w;
  const barW = slot * (1 - 2 * GAP);
  const top = niceMax(Math.max(0, ...buckets.map((b) => layers.reduce((n, l) => n + Math.max(0, b[l.key]), 0))));
  const first = count ? Date.parse(buckets[0].ts) : 0;
  const last = count ? Date.parse(buckets[count - 1].ts) : 0;
  const period: ChartPeriod = chartPeriod(Math.abs(last - first));
  const sample = count ? chartTick(first, period, tz) : "";
  const ticks = chartTickIndices(count, slot, sample.length * CHAR_PX);

  const lo = sel ? Math.min(sel.a, sel.b) : 0;
  const hi = sel ? Math.max(sel.a, sel.b) : 0;
  const selWindow = sel?.done ? selectionWindow(timeline, lo, hi) : null;
  const apply = () => {
    setSel(null);
    if (selWindow) onRange(selWindow.from, selWindow.to);
  };

  const pos = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || count === 0) return;
    const p = pos(e);
    const i = bucketAt(p.x, w, count);
    drag.current = { a: i, at: p };
    setFocus(null);
    setSel({ a: i, b: i, done: false, at: p });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pos(e);
    const i = bucketAt(p.x, w, count);
    setHover(count ? { i, ...p } : null);
    const d = drag.current;
    if (d) setSel({ a: d.a, b: i, done: false, at: d.at });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // The menu opens where the selection started (useChartHighlight.tsx:103-106).
    setSel({ a: d.a, b: bucketAt(pos(e).x, w, count), done: true, at: d.at });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || count === 0) return;
    if (e.key === "Escape" && sel) {
      e.preventDefault();
      e.stopPropagation();
      setSel(null);
      return;
    }
    const current = focus ?? count - 1;
    const at = { x: (current + 0.5) * slot, y: PLOT_H / 2 };
    if (e.key === "Enter") {
      e.preventDefault();
      setSel(sel ? { ...sel, done: true } : { a: current, b: current, done: true, at });
      return;
    }
    const next = moveBucket(e.key, current, count);
    if (next === null) return;
    e.preventDefault();
    if (e.shiftKey) setSel((s) => ({ a: s?.a ?? current, b: next, done: false, at: s?.at ?? at }));
    else setSel(null);
    setFocus(next);
  };

  const total = buckets.reduce((n, b) => n + b.requests, 0);
  const tipIndex = sel ? null : (focus ?? hover?.i ?? null);
  const tipAt = focus !== null ? { x: (focus + 0.5) * slot, y: PLOT_H / 2 } : hover;

  return (
    <section className="exc" aria-label="Requests over time">
      <div
        className="exc-plot"
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={`Requests over time: ${formatCount(total)} ${total === 1 ? "request" : "requests"} from ${windowText(timeline.from, timeline.to, tz)}`}
        aria-describedby={`${id}-hint`}
        data-measured={measured ?? undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setSel(null);
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node) || menu.current?.contains(e.relatedTarget as Node)) return;
          setFocus(null);
          if (!sel?.done) setSel(null);
        }}
      >
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true" focusable="false">
          {tipIndex !== null && tipIndex < count ? <rect className="exc-cursor" x={tipIndex * slot} y={0} width={slot} height={PLOT_H} /> : null}
          {buckets.map((b, i) => {
            let y = PLOT_H;
            return (
              <g key={b.ts} data-bucket={i}>
                {layers.map((l) => {
                  const v = Math.max(0, b[l.key]);
                  if (!v) return null;
                  const h = (v / top) * PLOT_H;
                  y -= h;
                  return <rect key={l.key} className={l.className} x={i * slot + slot * GAP} y={y} width={barW} height={h} />;
                })}
              </g>
            );
          })}
          {sel ? <rect className="exc-sel" x={lo * slot} y={0} width={(hi - lo + 1) * slot} height={PLOT_H} /> : null}
          {focus !== null && focus < count ? <rect className="exc-focus" x={focus * slot + 1} y={1} width={Math.max(1, slot - 2)} height={PLOT_H - 2} /> : null}
          {ticks.map((i) => (
            <text key={i} className="exc-tick" x={(i + 0.5) * slot} y={TICK_Y} dy="0.71em" textAnchor="middle">
              {chartTick(Date.parse(buckets[i].ts), period, tz)}
            </text>
          ))}
        </svg>
        {tipIndex !== null && tipAt && buckets[tipIndex] ? <Tip timeline={timeline} index={tipIndex} at={tipAt} width={w} period={period} layers={layers.map((l) => l.cls)} /> : null}
        {selWindow && sel ? (
          <div
            ref={menu}
            className="exc-menu"
            role="menu"
            aria-label="Selected range"
            style={{ left: Math.max(0, Math.min(sel.at.x, w - 240)), top: sel.at.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <p className="exc-menu__label">
              <span>{formatInstant(selWindow.from, { tz, withDay: true })}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
              <span>{formatInstant(selWindow.to, { tz, withDay: true })}</span>
            </p>
            <hr />
            <button type="button" role="menuitem" className="exc-menu__item" onClick={apply}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              Filter requests to selected range
            </button>
          </div>
        ) : null}
      </div>
      <p id={`${id}-hint`} className="ex-sr">
        Drag across bars, or click one, to select a time range, then Filter requests to selected range. With the keyboard, arrow keys pick a bar, Shift with the
        arrows selects several, Enter opens the menu, and Escape cancels.
      </p>
      <p className="ex-sr" aria-live="polite">
        {selWindow ? `Selected ${windowText(selWindow.from, selWindow.to, tz)}.` : focus !== null && buckets[focus] ? bucketWords(timeline, focus, tz) : ""}
      </p>
    </section>
  );
}

function bucketWords(t: RequestTimeline, i: number, tz: string): string {
  const b = (t.buckets ?? [])[i];
  const { start, end } = bucketSpan(t, b);
  return `${windowText(isoSecond(start), isoSecond(Math.ceil(end / 1000) * 1000), tz)}: ${formatCount(b.requests)} requests, ${formatCount(b.server_errors)} 5xx, ${formatCount(b.client_errors)} 4xx, ${formatCount(b.successful)} under 400`;
}

/**
 * Supabase's ChartTooltipContent (packages/ui chart.tsx:162-238): the bucket's time, then one row
 * per series in Bar order, each a 10px square, the level and its code, and the count. It follows
 * the pointer 10px right and below, as recharts' Tooltip, flipping to stay inside the plot.
 */
function Tip({ timeline, index, at, width, period, layers }: { timeline: RequestTimeline; index: number; at: { x: number; y: number }; width: number; period: ChartPeriod; layers: Layer[] }) {
  const tz = useTimeZone();
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const tw = ref.current?.offsetWidth ?? 0;
    setLeft(at.x + 10 + tw > width ? Math.max(0, at.x - 10 - tw) : at.x + 10);
  }, [at.x, width]);
  const b = (timeline.buckets ?? [])[index];
  if (!b) return null;
  return (
    <div ref={ref} className="exc-tip" aria-hidden="true" style={{ left: left ?? 0, top: at.y + 10, visibility: left === null ? "hidden" : undefined }}>
      <p className="exc-tip__when">{chartTooltipLabel(Date.parse(b.ts), period, tz)}</p>
      {LAYERS.filter((l) => layers.includes(l.cls)).map((l) => (
        <p key={l.key} className="exc-tip__row">
          <span className={`exc-swatch exc-swatch--${l.cls}`} />
          <span className="exc-tip__lv">
            <span>{l.level}</span>
            <span className="exc-tip__code">{l.code}</span>
          </span>
          <span className="exc-tip__n">{b[l.key] ? b[l.key].toLocaleString("en-US") : ""}</span>
        </p>
      ))}
    </div>
  );
}
