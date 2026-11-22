"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { windowText } from "@/lib/explore-timeline";
import { formatPercent, ratio } from "@/lib/format";
import { pointX, tooltipText } from "@/lib/chart-hover";
import { RANGE_LABEL, formatBucket, formatCount, sparklinePoints, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { type StatusRow, formatLatency, latencyTop, lineY, linePath, plotWidth } from "@/lib/traffic";
import { ChartAnnounce, ChartTooltip, Crosshair, type TooltipRow } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";
import { useTimeZone } from "@/lib/time-zone-context";
import { timeFraction, timeTicks } from "@/lib/chart-ticks";

/** The viewBox width drawn before the box is measured (server render), stretched by CSS. */
const FALLBACK_W = 960;
const H = 160;
/** The plot height every chart draws at; shared with the endpoint page (#593). */
export const PLOT_HEIGHT = H;

/**
 * The measured width of an element, in CSS pixels, kept current with a ResizeObserver; null until
 * it is measured or while it measures zero (hidden). Read synchronously after layout, so the first
 * client paint already uses it. This replaces v1's recharts ResponsiveContainer, which rendered at
 * `width(-1)` and then late or blank.
 */
export function useMeasuredWidth<T extends HTMLElement>() {
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
 * What a plot shows on hover, focus or tap (the shared chart hover, components/charts): one point
 * per bucket, laid out as bar slots (every chart here draws its bars, and its line vertices, at
 * slot centres). `title` names the bucket (its time, or its range for a histogram), `rows` gives
 * each series' exact value formatted with its unit, and `marks` draws the hovered bucket's
 * crosshair and dots into the SVG at width `w`.
 */
export interface PlotHover {
  count: number;
  /** What one point is called in the box's spoken hint: "bucket" (default), "range". */
  noun?: string;
  title: (i: number) => string;
  rows: (i: number) => TooltipRow[];
  marks?: (i: number, w: number) => ReactNode;
  /**
   * Each bucket's requests in Explore (#977), one link per point: a click on a bucket, Enter on the
   * focused plot or a second tap on the shown bucket opens it. Ignored unless there is one per point.
   */
  hrefs?: readonly string[];
  /**
   * Select mode (Traffic): a click on a bucket, or a drag across several, marks a window and opens
   * a small menu: filter this page to it (the default) or open it in Explore. `windows` is each
   * bucket's start and end; `page` and `explore` are links with `__FROM__` and `__TO__` in place of
   * the window's ends. It replaces `hrefs`.
   */
  select?: PlotSelect;
}

/** A plot's select mode (see PlotHover.select). */
export interface PlotSelect {
  windows: readonly { from: string; to: string }[];
  page: string;
  explore: string;
}

/** A link of a select template with the window's ends in it. */
const fillWindow = (template: string, from: string, to: string) => template.replace("__FROM__", encodeURIComponent(from)).replace("__TO__", encodeURIComponent(to));

/** Each bucket's window: from its start to the next bucket's (the last as long as the one before). */
export function bucketWindows(rows: readonly { ts: string }[]): { from: string; to: string }[] {
  return rows.map((r, i) => {
    const start = Date.parse(r.ts);
    const next = rows[i + 1] ? Date.parse(rows[i + 1].ts) : rows[i - 1] ? start + (start - Date.parse(rows[i - 1].ts)) : start + 60_000;
    return { from: new Date(start).toISOString().replace(".000Z", "Z"), to: new Date(next).toISOString().replace(".000Z", "Z") };
  });
}

/** What the tooltip of a plot whose buckets open in Explore says a click does. */
export const OPEN_HINT = "Click to see these requests in Explore";

/**
 * The plot box: measures itself and gives its children the width to draw at (and the hovered
 * bucket, to highlight it). With `hover` the box is focusable and every bucket reads exactly: the
 * pointer or a tap picks the bucket under it, the arrow keys step through them (Home/End jump,
 * Escape hides), and the tooltip stays inside the box. Screen readers get the chart's summary from
 * the SVG and each bucket from a live region.
 */
export function Plot({
  label,
  summary,
  top,
  scale,
  hover,
  overlay,
  children,
}: {
  label: string;
  summary: string;
  /** The top value's label above the plot (the older layout, without a value axis). */
  top?: string;
  /**
   * The value axis (#1004): the plot's top value and how to write a value. The top, the midline and
   * 0 are labelled in a gutter left of the plot; pair it with `<TimeAxis inset />`.
   */
  scale?: PlotScale;
  hover?: PlotHover;
  /** HTML drawn over the plot at width `w` (text the stretched SVG cannot carry: bar labels, marks). */
  overlay?: (w: number) => ReactNode;
  children: (w: number, active: number | null) => ReactNode;
}) {
  const [measureRef, measured] = useMeasuredWidth<HTMLDivElement>();
  const h = useChartHover<HTMLDivElement>(hover?.count ?? 0, "slot");
  const tz = useTimeZone();
  const w = measured ?? FALLBACK_W;
  const i = hover && hover.count > 0 ? h.index : null;
  const title = hover && i !== null ? hover.title(i) : "";
  const rows = hover && i !== null ? hover.rows(i) : [];
  const hoverRef = h.ref;
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      measureRef.current = el;
      hoverRef.current = el;
    },
    [measureRef, hoverRef],
  );
  const interactive = hover !== undefined && hover.count > 0;
  // Drill-down (#977): the shown bucket opens its requests in Explore.
  const router = useRouter();
  const select = interactive && hover.select && hover.select.windows.length === hover.count ? hover.select : null;
  const links = !select && interactive && hover.hrefs && hover.hrefs.length === hover.count ? hover.hrefs : null;
  // Select mode: the bucket a press started on, the marked range, and whether it is done (menu open).
  const [sel, setSel] = useState<{ a: number; b: number; done: boolean } | null>(null);
  const drag = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slotAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const n = hover?.count ?? 1;
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * n)));
  };
  useEffect(() => {
    if (!sel?.done) return;
    const down = (e: globalThis.PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node) || (e.target as Element | null)?.closest?.(".tr-plot--select")) return;
      setSel(null);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setSel(null);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    menuRef.current?.querySelector<HTMLElement>("a")?.focus();
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [sel?.done]);
  const lo = sel ? Math.min(sel.a, sel.b) : 0;
  const hi = sel ? Math.max(sel.a, sel.b) : 0;
  const picked = select && sel ? { from: select.windows[lo].from, to: select.windows[hi].to } : null;
  const selectBind = select
    ? {
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
          if (e.button !== 0) return;
          const i = slotAt(e);
          drag.current = i;
          setSel({ a: i, b: i, done: false });
          e.currentTarget.setPointerCapture?.(e.pointerId);
          h.bind.onPointerDown(e);
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
          h.bind.onPointerMove?.(e);
          if (drag.current !== null) setSel({ a: drag.current, b: slotAt(e), done: false });
        },
        onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
          if (drag.current === null) return;
          setSel({ a: drag.current, b: slotAt(e), done: true });
          drag.current = null;
        },
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" && !(e.metaKey || e.ctrlKey || e.altKey) && h.index !== null) {
            e.preventDefault();
            setSel({ a: h.index, b: h.index, done: true });
            return;
          }
          h.bind.onKeyDown(e);
        },
      }
    : {};
  // The bucket shown before a touch: a first tap only shows a bucket, a second tap on it opens it.
  const before = useRef<{ touch: boolean; index: number | null }>({ touch: false, index: null });
  const go = (at: number | null) => {
    if (links && at !== null && links[at]) router.push(links[at]);
  };
  const open = links
    ? {
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
          before.current = { touch: e.pointerType !== "mouse", index: h.index };
          h.bind.onPointerDown(e);
        },
        onClick: () => {
          if (before.current.touch && before.current.index !== h.index) return;
          go(h.index);
        },
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" && !(e.metaKey || e.ctrlKey || e.altKey) && h.index !== null) {
            e.preventDefault();
            go(h.index);
            return;
          }
          h.bind.onKeyDown(e);
        },
      }
    : {};
  const hint = select
    ? ` Press Enter, or drag across ${hover?.noun ?? "bucket"}s, to filter this page to a window.`
    : links
      ? ` Press Enter to see a ${hover?.noun ?? "bucket"}’s requests in Explore.`
      : "";
  const plot = (
    <>
      <div
        className={`tr-plot${interactive ? " tr-plot--hover ct-box" : ""}${links ? " tr-plot--open" : ""}${select ? " tr-plot--select" : ""}`}
        ref={setRef}
        {...(interactive ? { role: "group", "aria-label": `${label}. Use the arrow keys to read each ${hover.noun ?? "bucket"}.${hint}`, ...h.bind, ...open, ...selectBind } : {})}
      >
        {scale ? null : (
          <span className="tr-axis-top" aria-hidden="true">
            {top}
          </span>
        )}
        <svg viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}. ${summary}`} data-measured={measured ?? undefined}>
          <line className="tr-grid" x1="0" x2={w} y1={0.5} y2={0.5} />
          <line className="tr-grid" x1="0" x2={w} y1={H / 2} y2={H / 2} />
          <line className="tr-base" x1="0" x2={w} y1={H - 0.5} y2={H - 0.5} />
          {children(w, i)}
          {hover?.marks && i !== null ? hover.marks(i, w) : null}
          {sel && hover ? <rect className="tr-sel" x={(lo / hover.count) * w} y={0} width={((hi - lo + 1) / hover.count) * w} height={H} /> : null}
        </svg>
        {select && sel?.done && picked ? (
          <div
            ref={menuRef}
            className="tr-selmenu"
            role="menu"
            aria-label="Selected window"
            style={{ left: `${Math.min(88, Math.max(0, (((lo + hi + 1) / 2) / (hover?.count ?? 1)) * 100))}%` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <p className="tr-selmenu__when">{windowText(picked.from, picked.to, tz)}</p>
            <a role="menuitem" className="tr-selmenu__item is-primary" href={fillWindow(select.page, picked.from, picked.to)} onClick={() => setSel(null)}>
              Filter this page to this window
            </a>
            <a role="menuitem" className="tr-selmenu__item" href={fillWindow(select.explore, picked.from, picked.to)}>
              Open these requests in Explore
            </a>
          </div>
        ) : null}
        {overlay ? (
          <div className="tr-plot__overlay" aria-hidden="true">
            {overlay(w)}
          </div>
        ) : null}
        {interactive && i !== null && h.width > 0 && !sel?.done ? (
          <ChartTooltip
            x={pointX(i, h.width, hover.count, "slot")}
            boxWidth={h.width}
            title={title}
            rows={rows}
            placement="inside"
            hint={select ? "Click or drag to filter this page to a window" : links ? OPEN_HINT : undefined}
          />
        ) : null}
      </div>
      {interactive ? <ChartAnnounce text={i !== null ? tooltipText(title, rows) : ""} /> : null}
    </>
  );
  if (!scale) return plot;
  return (
    <div className="tr-yplot">
      <div className="tr-axis-y" aria-hidden="true">
        {yTicks(scale.top).map((v) => (
          <span key={v} style={{ top: `${(1 - v / scale.top) * 100}%` }}>
            {scale.format(v)}
          </span>
        ))}
      </div>
      {plot}
    </div>
  );
}

/** A plot's value axis: its top value and how a value is written on it. */
export interface PlotScale {
  top: number;
  format: (v: number) => string;
}

/** The labelled values of a value axis: the top, the midline and 0 (the plot's three grid lines). */
export const yTicks = (top: number): number[] => (top > 0 ? [top, top / 2, 0] : [0]);

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** A count on a value axis: `0`, `0.5`, `250`, `12.5K`, `1.2M`. */
export const formatAxisCount = (n: number) => COMPACT.format(n);

/** The hovered bucket on a line chart: a crosshair at its centre and a dot on each line. */
export function LineMarks({ i, count, w, dots }: { i: number; count: number; w: number; dots: readonly { y: number; className: string }[] }) {
  const x = pointX(i, w, count, "slot");
  return (
    <g aria-hidden="true">
      <Crosshair x={x} height={H} />
      {dots.map((d) => (
        <circle key={d.className} className={`ct-dot tr-dot ${d.className}`} cx={x} cy={d.y} r={3.5} />
      ))}
    </g>
  );
}

/**
 * The time axis under a plot (#1004): 3–5 round times in the user's time zone (fewer on a narrow
 * plot), each under the instant it names. With `inset` it lines up with a plot that has a value axis
 * (`scale`) and names the zone in the gutter; without, the first label carries the zone.
 */
export function TimeAxis({ rows, range, inset = false }: { rows: readonly { ts: string }[]; range: QueryRange; inset?: boolean }) {
  const tz = useTimeZone();
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>();
  const n = rows.length;
  const first = n ? Date.parse(rows[0].ts) : Number.NaN;
  const last = n ? Date.parse(rows[n - 1].ts) : Number.NaN;
  if (Number.isNaN(first) || Number.isNaN(last)) return null;
  // Buckets are equal: the axis runs from the first bucket's start to the last one's end.
  const step = n > 1 ? (last - first) / (n - 1) : 0;
  const w = measured ?? FALLBACK_W;
  const { ticks, zone } = timeTicks(first, first + step * n, tz, w < 360 ? 3 : w < 560 ? 4 : 5);
  const labels = ticks.length
    ? ticks.map((t) => ({ key: t.at, at: timeFraction(t.at, first, step, n), text: t.label }))
    : [{ key: first, at: 0, text: formatBucket(rows[0].ts, range, tz).replace(` ${zone}`, "") }];
  return (
    <figcaption className={`tr-axis-x tr-axis-x--ticks${inset ? " tr-axis-x--inset" : ""}`} aria-hidden="true">
      {inset ? <span className="tr-axis-x__zone">{zone}</span> : null}
      <div className="tr-axis-x__track" ref={ref}>
        {labels.map((t, k) => (
          <span key={t.key} className={`tr-tick${t.at < 0.06 ? " tr-tick--start" : t.at > 0.94 ? " tr-tick--end" : ""}`} style={{ left: `${t.at * 100}%` }}>
            {t.text}
            {!inset && k === 0 ? ` ${zone}` : ""}
          </span>
        ))}
      </div>
    </figcaption>
  );
}

type Status = "successful" | "client_errors" | "server_errors";
const STATUS: readonly { key: Status; label: string; className: string }[] = [
  { key: "successful", label: "Successful", className: "tr-fill-ok" },
  { key: "client_errors", label: "4xx", className: "tr-fill-4xx" },
  { key: "server_errors", label: "5xx", className: "tr-fill-5xx" },
];

/** A bucket of the status chart as tooltip rows: the total, then each class with its share. */
export function statusTipRows(r: StatusRow): TooltipRow[] {
  const total = r.successful + r.client_errors + r.server_errors;
  return [
    { label: "Requests", value: formatCount(total) },
    ...STATUS.map((s) => ({ label: s.label, value: total > 0 ? `${formatCount(r[s.key])} (${formatPercent(ratio(r[s.key], total))})` : "0", swatch: s.className })),
  ];
}

/**
 * Requests over time stacked by status class (successful, 4xx, 5xx), one bar per bucket. Hovering,
 * tapping or arrowing to a bucket shows its time, total and each class's count and share; the
 * legend names every series, so no series is told apart by color alone.
 */
export function StatusChart({
  label,
  summary,
  rows,
  range,
  hrefs,
  select,
}: {
  label: string;
  summary: string;
  rows: StatusRow[];
  range: QueryRange;
  /** Each bucket's requests in Explore (#977, bucketHrefs), one per row; without it the bars only read. */
  hrefs?: readonly string[];
  /** Select mode (Traffic): link templates for a picked window; the windows come from the rows. */
  select?: Omit<PlotSelect, "windows">;
}) {
  const tz = useTimeZone();
  const keys = STATUS.map((s) => s.key);
  const className = Object.fromEntries(STATUS.map((s) => [s.key, s.className])) as Record<Status, string>;
  const { top } = stackBars(rows, keys, FALLBACK_W, H);
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range, tz),
    rows: (i) => statusTipRows(rows[i]),
    hrefs,
    ...(select ? { select: { ...select, windows: bucketWindows(rows) } } : {}),
  };
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        {STATUS.map((s) => (
          <li key={s.key}>
            <span className={`tr-swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <Plot label={label} summary={summary} scale={{ top, format: formatAxisCount }} hover={hover}>
        {(w, active) =>
          stackBars(rows, keys, w, H).bars.map((b) => (
            <g key={b.index} className="tr-bucket">
              <rect className={`tr-hit${active === b.index ? " is-on" : ""}`} x={b.x} y={0} width={b.w} height={H} />
              {b.segments.map((s) => (
                <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
              ))}
            </g>
          ))
        }
      </Plot>
      <TimeAxis rows={rows} range={range} inset />
    </figure>
  );
}

/** p95 latency over time as a line, one point per bucket; hovering a bucket shows its p95. */
export function LatencyChart({
  label,
  summary,
  rows,
  range,
  select,
}: {
  label: string;
  summary: string;
  rows: { ts: string; p95_ms: number }[];
  range: QueryRange;
  /** Select mode (Traffic), as StatusChart's. */
  select?: Omit<PlotSelect, "windows">;
}) {
  const tz = useTimeZone();
  const values = rows.map((r) => r.p95_ms);
  const top = latencyTop(values);
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range, tz),
    rows: (i) => [{ label: "p95", value: formatLatency(values[i]), swatch: "tr-sw-line" }],
    marks: (i, w) => <LineMarks i={i} count={rows.length} w={w} dots={[{ y: lineY(values[i], H, top), className: "tr-dot--accent" }]} />,
    ...(select ? { select: { ...select, windows: bucketWindows(rows) } } : {}),
  };
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        <li>
          <span className="tr-swatch tr-fill-line" aria-hidden="true" />
          p95
        </li>
      </ul>
      <Plot label={label} summary={summary} scale={{ top, format: formatLatency }} hover={hover}>
        {(w, active) => {
          const slot = rows.length ? w / rows.length : w;
          return (
            <>
              {rows.map((r, i) => (
                <rect key={r.ts} className={`tr-hit${active === i ? " is-on" : ""}`} x={i * slot} y={0} width={slot} height={H} />
              ))}
              <path className="tr-line" d={linePath(values, w, H, top)} />
            </>
          );
        }}
      </Plot>
      <TimeAxis rows={rows} range={range} inset />
    </figure>
  );
}

const SPARK_W = 120;
const SPARK_H = 24;

/** One sparkline point as the tooltip shows it: the bucket time and the value, already formatted. */
export interface SparkPoint {
  ts: string;
  text: string;
}

/**
 * A tile's recent history as a small line. Without `hover` it is decorative (the tile has the
 * number). With `hover` (the shared chart hover, components/charts) hovering, tapping or arrowing
 * through it shows that point's bucket and exact value in a tooltip, with a crosshair and a dot on
 * the line, and reads it to screen readers. `hover.points[i]` is the bucket time and the formatted
 * value of `values[i]`, formatted by the caller (formatCount, formatLatency…) so the server can
 * pass it.
 */
export function Sparkline({ values, hover }: { values: readonly number[]; hover?: { label: string; range: QueryRange; points: readonly SparkPoint[] } }) {
  if (values.length === 0) return <span className="tr-spark" aria-hidden="true" />;
  if (hover && hover.points.length === values.length) return <HoverSparkline values={values} {...hover} />;
  return (
    <svg className="tr-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={sparklinePoints(values, SPARK_W, SPARK_H)} />
    </svg>
  );
}

function HoverSparkline({ values, label, range, points }: { values: readonly number[]; label: string; range: QueryRange; points: readonly SparkPoint[] }) {
  const tz = useTimeZone();
  const n = values.length;
  const hover = useChartHover<HTMLDivElement>(n, "point");
  const i = hover.index;
  const max = Math.max(...values, 0);
  // The same y as sparklinePoints, in px (the box is SPARK_H px tall).
  const y = (v: number) => (max > 0 ? SPARK_H - 1 - (v / max) * (SPARK_H - 2) : SPARK_H - 1);
  const title = i !== null ? formatBucket(points[i].ts, range, tz) : "";
  const rows = i !== null ? [{ label, value: points[i].text }] : [];
  const first = points[0];
  const last = points[n - 1];
  return (
    <>
      <div
        ref={hover.ref}
        className="tr-spark tr-spark--hover ct-box"
        role="group"
        aria-label={`${label} in the last ${RANGE_LABEL[range]}, from ${first.text} (${formatBucket(first.ts, range, tz)}) to ${last.text} (${formatBucket(last.ts, range, tz)}). Use the arrow keys to read each point.`}
        {...hover.bind}
      >
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <polyline points={sparklinePoints(values, SPARK_W, SPARK_H)} />
          {i !== null ? <Crosshair x={pointX(i, SPARK_W, n, "point")} height={SPARK_H} /> : null}
        </svg>
        {i !== null && hover.width > 0 ? (
          <>
            <span className="ct-dot-html" style={{ left: pointX(i, hover.width, n, "point"), top: y(values[i]) }} />
            <ChartTooltip x={pointX(i, hover.width, n, "point")} boxWidth={hover.width} title={title} rows={rows} />
          </>
        ) : null}
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, rows) : ""} />
    </>
  );
}
