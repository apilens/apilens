"use client";

import { pointX, tooltipText } from "@/lib/chart-hover";
import { formatBucket, formatCount, sparklinePoints, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { ChartAnnounce, ChartTooltip, Crosshair } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";

const W = 960;
const H = 160;

export interface Series<K extends string> {
  key: K;
  label: string;
  /** A CSS class setting the series fill (tokens only, in consumers.css). */
  className: string;
}

/**
 * A stacked bar chart over time (one bar per bucket), drawn as inline SVG. Hovering, tapping or
 * arrowing through it (the shared chart hover) shows the bucket's time and every series' exact
 * value, plus the bucket total, and reads it to screen readers. The legend names every series, so
 * identity never rests on color alone. `label` is the chart's accessible name and `summary` its
 * text alternative.
 */
export function StackedBars<K extends string>({
  label,
  summary,
  rows,
  series,
  range,
  totalLabel,
}: {
  label: string;
  summary: string;
  rows: (Record<K, number> & { ts: string })[];
  series: readonly Series<K>[];
  range: QueryRange;
  /** The name of the bucket total in the tooltip ("Consumers", "Requests"); omitted when null. */
  totalLabel?: string;
}) {
  const { top, bars } = stackBars(rows, series.map((s) => s.key), W, H);
  const hover = useChartHover<HTMLDivElement>(rows.length, "slot");
  const i = hover.index;
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const firstTs = rows[0]?.ts;
  const lastTs = rows[rows.length - 1]?.ts;
  const title = i !== null ? formatBucket(rows[i].ts, range) : "";
  // Top of the stack first, as the bars read.
  const tipRows =
    i !== null
      ? [
          ...(totalLabel ? [{ label: totalLabel, value: formatCount(bars[i].total) }] : []),
          ...[...series].reverse().map((s) => ({ label: s.label, value: formatCount(rows[i][s.key] ?? 0), swatch: s.className })),
        ]
      : [];
  const slot = rows.length ? W / rows.length : W;
  return (
    <figure className="cs-chart">
      <ul className="cs-legend" aria-label={`${label} legend`}>
        {series.map((s) => (
          <li key={s.key}>
            <span className={`cs-swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="cs-plot">
        <span className="cs-axis-top" aria-hidden="true">
          {formatCount(top)}
        </span>
        <div ref={hover.ref} className="ct-box cs-plot__box" role="group" aria-label={`${label}. ${summary} Use the arrow keys to read each bucket.`} {...hover.bind}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <line className="cs-grid" x1="0" x2={W} y1={0.5} y2={0.5} />
            <line className="cs-grid" x1="0" x2={W} y1={H / 2} y2={H / 2} />
            <line className="cs-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
            {i !== null ? <rect className="ct-bar-hover" x={i * slot} y={0} width={slot} height={H} /> : null}
            {bars.map((b) => (
              <g key={b.index}>
                {b.segments.map((s) => (
                  <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
                ))}
              </g>
            ))}
          </svg>
          {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, rows.length, "slot")} boxWidth={hover.width} title={title} rows={tipRows} placement="inside" /> : null}
        </div>
        <ChartAnnounce text={i !== null ? tooltipText(title, tipRows) : ""} />
      </div>
      {firstTs && lastTs ? (
        <figcaption className="cs-axis-x" aria-hidden="true">
          <span>{formatBucket(firstTs, range)}</span>
          <span>{formatBucket(lastTs, range)}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}

const SPARK_W = 96;
const SPARK_H = 22;

/**
 * Requests per bucket as a small line, for the consumers and groups tables. With `times` (each
 * bucket's start) it is hoverable through the shared chart hover: the bucket and its exact request
 * count show in a tooltip, with a crosshair and a dot, and are read to screen readers. `name` is
 * whose requests they are, for the accessible label.
 */
export function Sparkline({ values, times, range, name }: { values: readonly number[] | null; times: readonly string[]; range: QueryRange; name: string }) {
  const v = values ?? [];
  if (v.length === 0) return null;
  if (times.length !== v.length) {
    return (
      <svg className="cs-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <polyline points={sparklinePoints(v, SPARK_W, SPARK_H)} />
      </svg>
    );
  }
  return <HoverSparkline values={v} times={times} range={range} name={name} />;
}

function HoverSparkline({ values, times, range, name }: { values: readonly number[]; times: readonly string[]; range: QueryRange; name: string }) {
  const n = values.length;
  const hover = useChartHover<HTMLDivElement>(n, "point");
  const i = hover.index;
  const max = Math.max(...values, 0);
  // The same y as sparklinePoints, in px (the box is SPARK_H px tall).
  const y = (val: number) => (max > 0 ? SPARK_H - 1 - (val / max) * (SPARK_H - 2) : SPARK_H - 1);
  const title = i !== null ? formatBucket(times[i], range) : "";
  const rows = i !== null ? [{ label: "Requests", value: formatCount(values[i]) }] : [];
  const peak = values.indexOf(max);
  return (
    <>
      <div
        ref={hover.ref}
        className="cs-spark ct-box"
        role="group"
        aria-label={`Requests over time for ${name}, peaking at ${formatCount(max)} (${formatBucket(times[peak], range)}). Use the arrow keys to read each bucket.`}
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
