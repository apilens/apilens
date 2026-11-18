"use client";

import { type KeyboardEvent, type PointerEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { timeFraction, timeTicks } from "@/lib/chart-ticks";
import { formatCount, stackBars } from "@/lib/consumers";
import { DRAG_THRESHOLD_PX, bucketAt, bucketSpan, isoSecond, moveBucket, selectionWindow, windowText } from "@/lib/explore-timeline";
import type { RequestTimeline } from "@/lib/identity";
import { useTimeZone } from "@/lib/time-zone-context";
import { plotWidth } from "@/lib/traffic";

/** The viewBox width drawn before the plot is measured (server render), stretched by CSS. */
const FALLBACK_W = 960;
/** Plot height in px (Supabase's 60px); the CSS uses the same number. */
const H = 60;

/** The layers, bottom up: under 400 grey, 4xx amber, 5xx red. */
const LAYERS = [
  { key: "successful", cls: "2xx", label: "2xx–3xx", className: "exc-ok" },
  { key: "client_errors", cls: "4xx", label: "4xx", className: "exc-4xx" },
  { key: "server_errors", cls: "5xx", label: "5xx", className: "exc-5xx" },
] as const;

type Layer = (typeof LAYERS)[number]["cls"];

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(plotWidth(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Explore's status chart (#1052, after Supabase's TimelineChart): requests per bucket, 60px tall,
 * stacked grey (under 400), amber (4xx) and red (5xx), with no gridlines and 3–5 time ticks in the
 * viewer's zone. A layer the status filter leaves out is not drawn. Drag across bars, or click one,
 * to select a window; "Filter to selected range" then narrows the page to it (`onRange`). Keyboard:
 * arrows pick a bar, Shift with the arrows selects several, Enter selects the bar, Esc cancels.
 * `timeline` is null when the API could not answer.
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
  const [hover, setHover] = useState<number | null>(null);
  // A drag in progress, or a finished selection waiting for "Filter to selected range".
  const [sel, setSel] = useState<{ a: number; b: number; done: boolean } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const drag = useRef<{ x: number; a: number; moved: boolean } | null>(null);

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
  const { bars } = stackBars(
    buckets.map((b) => ({ successful: b.successful, client_errors: b.client_errors, server_errors: b.server_errors })),
    layers.map((l) => l.key),
    w,
    H,
  );
  const slot = count ? w / count : w;
  const first = count ? Date.parse(buckets[0].ts) : 0;
  const step = timeline.bucket_seconds * 1000;
  const ticks = count ? timeTicks(first, first + step * count, tz, 5) : null;

  const finish = (a: number, b: number) => setSel({ a: Math.min(a, b), b: Math.max(a, b), done: true });
  const apply = () => {
    if (!sel) return;
    const z = selectionWindow(timeline, sel.a, sel.b);
    setSel(null);
    if (z) onRange(z.from, z.to);
  };

  const xOf = (e: PointerEvent<HTMLDivElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || count === 0 || (e.target as HTMLElement).closest(".exc-pop")) return;
    const x = xOf(e);
    drag.current = { x, a: bucketAt(x, w, count), moved: false };
    setFocus(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const x = xOf(e);
    const i = bucketAt(x, w, count);
    setHover(count ? i : null);
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(x - d.x) >= DRAG_THRESHOLD_PX) d.moved = true;
    if (d.moved) setSel({ a: d.a, b: i, done: false });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // A click selects its one bar; a drag the bars it crossed.
    finish(d.a, d.moved ? bucketAt(xOf(e), w, count) : d.a);
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
    if (e.key === "Enter") {
      e.preventDefault();
      if (sel?.done) apply();
      else if (sel) finish(sel.a, sel.b);
      else finish(current, current);
      return;
    }
    const next = moveBucket(e.key, current, count);
    if (next === null) return;
    e.preventDefault();
    if (e.shiftKey) setSel((s) => ({ a: s?.a ?? current, b: next, done: false }));
    else setSel(null);
    setFocus(next);
  };

  const shownBar = focus ?? hover;
  const lo = sel ? Math.min(sel.a, sel.b) : 0;
  const hi = sel ? Math.max(sel.a, sel.b) : 0;
  const total = buckets.reduce((n, b) => n + b.requests, 0);
  const tipBucket = shownBar !== null && !sel?.done ? buckets[shownBar] : undefined;
  const selWindow = sel?.done ? selectionWindow(timeline, lo, hi) : null;

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
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setFocus(null);
          if (!sel?.done) setSel(null);
        }}
      >
        <svg viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {shownBar !== null && shownBar < count ? <rect className="exc-hover" x={shownBar * slot} y={0} width={slot} height={H} /> : null}
          {bars.map((b) => (
            <g key={b.index} data-bucket={b.index}>
              {b.segments.map((s) => (
                <rect key={s.key} className={LAYERS.find((l) => l.key === s.key)?.className} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 1.5 : 0} />
              ))}
            </g>
          ))}
          {sel ? <rect className="exc-sel" x={lo * slot} y={0} width={(hi - lo + 1) * slot} height={H} /> : null}
          {focus !== null && focus < count ? <rect className="exc-focus" x={focus * slot + 1} y={1} width={Math.max(1, slot - 2)} height={H - 2} /> : null}
        </svg>
        {tipBucket ? <Tip timeline={timeline} index={shownBar ?? 0} slot={slot} width={w} layers={layers.map((l) => l.cls)} /> : null}
        {selWindow ? (
          <div className="exc-pop" style={{ left: Math.max(0, Math.min(((lo + hi + 1) / 2) * slot - 90, w - 180)) }}>
            <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={apply} onPointerDown={(e) => e.stopPropagation()}>
              Filter to selected range
            </button>
            <span className="exc-pop__when">{windowText(selWindow.from, selWindow.to, tz)}</span>
          </div>
        ) : null}
      </div>
      {ticks ? (
        <div className="exc-axis" aria-hidden="true">
          {ticks.ticks.map((t, i) => {
            const f = timeFraction(t.at, first, step, count);
            // Ticks near an edge lean inward, so their label never leaves the plot.
            const shift = f > 0.88 ? "-100%" : f < 0.06 ? "0" : "-50%";
            return (
            <span key={t.at} style={{ left: `${f * 100}%`, transform: `translateX(${shift})` }}>
              {t.label}
              {i === ticks.ticks.length - 1 ? ` ${ticks.zone}` : ""}
            </span>
            );
          })}
        </div>
      ) : null}
      <p id={`${id}-hint`} className="ex-sr">
        Drag across bars, or click one, to select a time range, then Filter to selected range. With the keyboard, arrow keys pick a bar, Shift with the arrows selects
        several, Enter selects and then filters, and Escape cancels.
      </p>
      <p className="ex-sr" aria-live="polite">
        {selWindow ? `Selected ${windowText(selWindow.from, selWindow.to, tz)}. Press Enter to filter to it.` : focus !== null && buckets[focus] ? bucketWords(timeline, focus, tz) : ""}
      </p>
    </section>
  );
}

function bucketWords(t: RequestTimeline, i: number, tz: string): string {
  const b = (t.buckets ?? [])[i];
  const { start, end } = bucketSpan(t, b);
  return `${windowText(isoSecond(start), isoSecond(Math.ceil(end / 1000) * 1000), tz)}: ${formatCount(b.requests)} requests, ${formatCount(b.successful)} under 400, ${formatCount(b.client_errors)} 4xx, ${formatCount(b.server_errors)} 5xx`;
}

/** A bar's tooltip: its time range, each class's count and the total, kept inside the plot. */
function Tip({ timeline, index, slot, width, layers }: { timeline: RequestTimeline; index: number; slot: number; width: number; layers: Layer[] }) {
  const tz = useTimeZone();
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const center = (index + 0.5) * slot;
  useLayoutEffect(() => {
    const tw = ref.current?.offsetWidth ?? 0;
    setLeft(Math.max(0, Math.min(center + 12, width - tw)));
  }, [center, width]);
  const b = (timeline.buckets ?? [])[index];
  if (!b) return null;
  const { start, end } = bucketSpan(timeline, b);
  const rows: [Layer, string, number][] = [
    ["2xx", "2xx–3xx", b.successful],
    ["4xx", "4xx", b.client_errors],
    ["5xx", "5xx", b.server_errors],
  ];
  return (
    <div ref={ref} className="exc-tip" aria-hidden="true" style={{ left: left ?? 0, visibility: left === null ? "hidden" : undefined }}>
      <p className="exc-tip__when">{windowText(isoSecond(start), isoSecond(Math.ceil(end / 1000) * 1000), tz)}</p>
      {rows
        .filter(([cls]) => layers.includes(cls))
        .map(([cls, label, n]) => (
          <p key={cls} className="exc-tip__row">
            <span className={`exc-swatch exc-swatch--${cls}`} />
            <span>{label}</span>
            <span className="exc-tip__n">{formatCount(n)}</span>
          </p>
        ))}
      <p className="exc-tip__row exc-tip__total">
        <span />
        <span>Total</span>
        <span className="exc-tip__n">{formatCount(b.requests)}</span>
      </p>
    </div>
  );
}
