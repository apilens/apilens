"use client";

import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { pointX, tooltipText } from "@/lib/chart-hover";
import { RANGE_LABEL, formatBucket, formatCount, formatRate, sparklinePoints, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { type StatusRow, formatLatency, latencyTop, lineY, linePath, plotWidth } from "@/lib/traffic";
import { ChartAnnounce, ChartTooltip, Crosshair, type TooltipRow } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";

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
}

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
  hover,
  children,
}: {
  label: string;
  summary: string;
  top: string;
  hover?: PlotHover;
  children: (w: number, active: number | null) => ReactNode;
}) {
  const [measureRef, measured] = useMeasuredWidth<HTMLDivElement>();
  const h = useChartHover<HTMLDivElement>(hover?.count ?? 0, "slot");
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
  return (
    <>
      <div
        className={`tr-plot${interactive ? " tr-plot--hover ct-box" : ""}`}
        ref={setRef}
        {...(interactive ? { role: "group", "aria-label": `${label}. Use the arrow keys to read each ${hover.noun ?? "bucket"}.`, ...h.bind } : {})}
      >
        <span className="tr-axis-top" aria-hidden="true">
          {top}
        </span>
        <svg viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}. ${summary}`} data-measured={measured ?? undefined}>
          <line className="tr-grid" x1="0" x2={w} y1={0.5} y2={0.5} />
          <line className="tr-grid" x1="0" x2={w} y1={H / 2} y2={H / 2} />
          <line className="tr-base" x1="0" x2={w} y1={H - 0.5} y2={H - 0.5} />
          {children(w, i)}
          {hover?.marks && i !== null ? hover.marks(i, w) : null}
        </svg>
        {interactive && i !== null && h.width > 0 ? (
          <ChartTooltip x={pointX(i, h.width, hover.count, "slot")} boxWidth={h.width} title={title} rows={rows} placement="inside" />
        ) : null}
      </div>
      {interactive ? <ChartAnnounce text={i !== null ? tooltipText(title, rows) : ""} /> : null}
    </>
  );
}

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

export function TimeAxis({ rows, range }: { rows: { ts: string }[]; range: QueryRange }) {
  const firstTs = rows[0]?.ts;
  const lastTs = rows[rows.length - 1]?.ts;
  if (!firstTs || !lastTs) return null;
  return (
    <figcaption className="tr-axis-x" aria-hidden="true">
      <span>{formatBucket(firstTs, range)}</span>
      <span>{formatBucket(lastTs, range)}</span>
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
    ...STATUS.map((s) => ({ label: s.label, value: total > 0 ? `${formatCount(r[s.key])} (${formatRate(r[s.key], total)})` : "0", swatch: s.className })),
  ];
}

/**
 * Requests over time stacked by status class (successful, 4xx, 5xx), one bar per bucket. Hovering,
 * tapping or arrowing to a bucket shows its time, total and each class's count and share; the
 * legend names every series, so no series is told apart by color alone.
 */
export function StatusChart({ label, summary, rows, range }: { label: string; summary: string; rows: StatusRow[]; range: QueryRange }) {
  const keys = STATUS.map((s) => s.key);
  const className = Object.fromEntries(STATUS.map((s) => [s.key, s.className])) as Record<Status, string>;
  const { top } = stackBars(rows, keys, FALLBACK_W, H);
  const hover: PlotHover = { count: rows.length, title: (i) => formatBucket(rows[i].ts, range), rows: (i) => statusTipRows(rows[i]) };
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
      <Plot label={label} summary={summary} top={formatCount(top)} hover={hover}>
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
      <TimeAxis rows={rows} range={range} />
    </figure>
  );
}

/** p95 latency over time as a line, one point per bucket; hovering a bucket shows its p95. */
export function LatencyChart({ label, summary, rows, range }: { label: string; summary: string; rows: { ts: string; p95_ms: number }[]; range: QueryRange }) {
  const values = rows.map((r) => r.p95_ms);
  const top = latencyTop(values);
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range),
    rows: (i) => [{ label: "p95", value: formatLatency(values[i]), swatch: "tr-sw-line" }],
    marks: (i, w) => <LineMarks i={i} count={rows.length} w={w} dots={[{ y: lineY(values[i], H, top), className: "tr-dot--accent" }]} />,
  };
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        <li>
          <span className="tr-swatch tr-fill-line" aria-hidden="true" />
          p95
        </li>
      </ul>
      <Plot label={label} summary={summary} top={formatLatency(top)} hover={hover}>
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
      <TimeAxis rows={rows} range={range} />
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
  const n = values.length;
  const hover = useChartHover<HTMLDivElement>(n, "point");
  const i = hover.index;
  const max = Math.max(...values, 0);
  // The same y as sparklinePoints, in px (the box is SPARK_H px tall).
  const y = (v: number) => (max > 0 ? SPARK_H - 1 - (v / max) * (SPARK_H - 2) : SPARK_H - 1);
  const title = i !== null ? formatBucket(points[i].ts, range) : "";
  const rows = i !== null ? [{ label, value: points[i].text }] : [];
  const first = points[0];
  const last = points[n - 1];
  return (
    <>
      <div
        ref={hover.ref}
        className="tr-spark tr-spark--hover ct-box"
        role="group"
        aria-label={`${label} in the last ${RANGE_LABEL[range]}, from ${first.text} (${formatBucket(first.ts, range)}) to ${last.text} (${formatBucket(last.ts, range)}). Use the arrow keys to read each point.`}
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
