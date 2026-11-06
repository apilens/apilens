"use client";

// Charts of the endpoint page (#593) on the Traffic page's measured plot box (#592), so they share
// its no-blank-first-paint behaviour and its hover: lines over time, stacked bars over time and
// histograms. Every chart has a legend or a single named series, and every bucket can be hovered,
// tapped or reached with the arrow keys to read its exact values, so no series is told apart by
// color alone.
import { formatBucket, formatCount, niceMax, stackBars } from "@/lib/consumers";
import { formatBytes, formatPercent, formatShare } from "@/lib/endpoint-detail";
import type { QueryRange } from "@/lib/identity";
import { formatLatency, lineY, linePath } from "@/lib/traffic";
import { PLOT_HEIGHT as H, LineMarks, Plot, type PlotHover, TimeAxis } from "../traffic/charts";

/** What a chart's values are; the server passes the name (functions cannot cross to the client). */
export type Unit = "count" | "ms" | "bytes" | "percent";
const FORMAT: Record<Unit, (v: number) => string> = { count: formatCount, ms: formatLatency, bytes: formatBytes, percent: formatPercent };

export interface Series<K extends string> {
  key: K;
  label: string;
  /** Fill or stroke class from endpoint.css (`ep-c1`…), also used by the legend swatch. */
  className: string;
}

function Legend<K extends string>({ label, series, line }: { label: string; series: readonly Series<K>[]; line?: boolean }) {
  return (
    <ul className="tr-legend" aria-label={`${label} legend`}>
      {series.map((s) => (
        <li key={s.key}>
          <span className={`tr-swatch ${line ? "ep-swatch-line " : ""}${s.className}`} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

type Row<K extends string> = { ts: string } & Record<K, number>;

/** Several series over time as lines, one point per bucket, scaled to a shared round top. */
export function LinesChart<K extends string>({
  label,
  summary,
  rows,
  series,
  unit,
  range,
}: {
  label: string;
  summary: string;
  rows: readonly Row<K>[];
  series: readonly Series<K>[];
  unit: Unit;
  range: QueryRange;
}) {
  const top = niceMax(Math.max(0, ...rows.flatMap((r) => series.map((s) => r[s.key]))));
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range),
    rows: (i) => series.map((s) => ({ label: s.label, value: FORMAT[unit](rows[i][s.key]), swatch: s.className })),
    marks: (i, w) => <LineMarks i={i} count={rows.length} w={w} dots={series.map((s) => ({ y: lineY(rows[i][s.key], H, top), className: s.className }))} />,
  };
  return (
    <figure className="tr-chart">
      <Legend label={label} series={series} line />
      <Plot label={label} summary={summary} top={FORMAT[unit](top)} hover={hover}>
        {(w, active) => {
          const slot = rows.length ? w / rows.length : w;
          return (
            <>
              {rows.map((r, i) => (
                <rect key={r.ts} className={`tr-hit${active === i ? " is-on" : ""}`} x={i * slot} y={0} width={slot} height={H} />
              ))}
              {series.map((s) => (
                <path
                  key={s.key}
                  className={`ep-line ${s.className}`}
                  data-series={s.key}
                  d={linePath(
                    rows.map((r) => r[s.key]),
                    w,
                    H,
                    top,
                  )}
                />
              ))}
            </>
          );
        }}
      </Plot>
      <TimeAxis rows={[...rows]} range={range} />
    </figure>
  );
}

/** Several series over time as stacked bars, one bar per bucket; hover adds the bucket's total. */
export function StackedChart<K extends string>({
  label,
  summary,
  rows,
  series,
  unit,
  range,
}: {
  label: string;
  summary: string;
  rows: readonly Row<K>[];
  series: readonly Series<K>[];
  unit: Unit;
  range: QueryRange;
}) {
  const keys = series.map((s) => s.key);
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const { top } = stackBars([...rows], keys, 1, H);
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range),
    rows: (i) => {
      const out = series.map((s) => ({ label: s.label, value: FORMAT[unit](rows[i][s.key]), swatch: s.className }));
      if (series.length < 2) return out;
      return [...out, { label: "Total", value: FORMAT[unit](series.reduce((sum, s) => sum + Math.max(0, rows[i][s.key] ?? 0), 0)) }];
    },
  };
  return (
    <figure className="tr-chart">
      <Legend label={label} series={series} />
      <Plot label={label} summary={summary} top={FORMAT[unit](top)} hover={hover}>
        {(w, active) =>
          stackBars([...rows], keys, w, H).bars.map((b) => (
            <g key={b.index} className="tr-bucket">
              <rect className={`tr-hit${active === b.index ? " is-on" : ""}`} x={b.x} y={0} width={b.w} height={H} />
              {b.segments.map((s) => (
                <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
              ))}
            </g>
          ))
        }
      </Plot>
      <TimeAxis rows={[...rows]} range={range} />
    </figure>
  );
}

/**
 * A distribution as bars, one per bucket, its edges under the first and last bar. Hovering a bar
 * shows its range, its count and its share of every counted value.
 */
export function Histogram({
  label,
  summary,
  buckets,
  unit,
  valueLabel = "Requests",
}: {
  label: string;
  summary: string;
  buckets: readonly { label: string; count: number }[];
  unit: Unit;
  /** What a bar counts, for the tooltip. */
  valueLabel?: string;
}) {
  const rows = buckets.map((b) => ({ count: b.count }));
  const { top } = stackBars(rows, ["count"], 1, H);
  const total = buckets.reduce((sum, b) => sum + Math.max(0, b.count), 0);
  const hover: PlotHover = {
    count: buckets.length,
    noun: "range",
    title: (i) => buckets[i].label,
    rows: (i) => [
      { label: valueLabel, value: FORMAT[unit](buckets[i].count) },
      { label: "Share", value: formatShare(total > 0 ? buckets[i].count / total : 0) },
    ],
  };
  return (
    <figure className="tr-chart">
      <Plot label={label} summary={summary} top={FORMAT[unit](top)} hover={hover}>
        {(w, active) =>
          stackBars(rows, ["count"], w, H).bars.map((b) => (
            <g key={b.index} className="tr-bucket">
              <rect className={`tr-hit${active === b.index ? " is-on" : ""}`} x={b.x} y={0} width={b.w} height={H} />
              {b.segments.map((s) => (
                <rect key={s.key} className="ep-c-bar" x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
              ))}
            </g>
          ))
        }
      </Plot>
      {buckets.length ? (
        <figcaption className="tr-axis-x" aria-hidden="true">
          <span>{buckets[0].label}</span>
          <span>{buckets[buckets.length - 1].label}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
