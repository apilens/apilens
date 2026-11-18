"use client";

// Charts of the endpoint page (#593) on the Traffic page's measured plot box (#592), so they share
// its no-blank-first-paint behaviour, its hover and its axes (#1004): lines over time, stacked bars
// over time and histograms. Every chart has a legend or a single named series, and every bucket can
// be hovered, tapped or reached with the arrow keys to read its exact values, so no series is told
// apart by color alone.
import { formatBucket, formatCount, niceMax, stackBars } from "@/lib/consumers";
import { formatPercent } from "@/lib/format";
import { formatBytes } from "@/lib/endpoint-detail";
import type { QueryRange } from "@/lib/identity";
import { formatLatency, lineY, linePath } from "@/lib/traffic";
import { type EdgedBucket, type Mark, bucketFraction, labelEvery, trimHistogram } from "@/lib/chart-ticks";
import { PLOT_HEIGHT as H, LineMarks, Plot, type PlotHover, TimeAxis, formatAxisCount, useMeasuredWidth } from "../traffic/charts";
import { useTimeZone } from "@/lib/time-zone-context";

/** What a chart's values are; the server passes the name (functions cannot cross to the client). */
export type Unit = "count" | "ms" | "bytes" | "percent";
const FORMAT: Record<Unit, (v: number) => string> = { count: formatCount, ms: formatLatency, bytes: formatBytes, percent: (v) => formatPercent(v / 100) };
/** A value on a value axis: counts compact (`12.5K`) so the gutter stays narrow. */
const AXIS: Record<Unit, (v: number) => string> = { ...FORMAT, count: formatAxisCount };

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
  const tz = useTimeZone();
  const top = niceMax(Math.max(0, ...rows.flatMap((r) => series.map((s) => r[s.key]))));
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range, tz),
    rows: (i) => series.map((s) => ({ label: s.label, value: FORMAT[unit](rows[i][s.key]), swatch: s.className })),
    marks: (i, w) => <LineMarks i={i} count={rows.length} w={w} dots={series.map((s) => ({ y: lineY(rows[i][s.key], H, top), className: s.className }))} />,
  };
  return (
    <figure className="tr-chart">
      <Legend label={label} series={series} line />
      <Plot label={label} summary={summary} scale={{ top, format: AXIS[unit] }} hover={hover}>
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
      <TimeAxis rows={rows} range={range} inset />
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
  const tz = useTimeZone();
  const keys = series.map((s) => s.key);
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const { top } = stackBars([...rows], keys, 1, H);
  const hover: PlotHover = {
    count: rows.length,
    title: (i) => formatBucket(rows[i].ts, range, tz),
    rows: (i) => {
      const out = series.map((s) => ({ label: s.label, value: FORMAT[unit](rows[i][s.key]), swatch: s.className }));
      if (series.length < 2) return out;
      return [...out, { label: "Total", value: FORMAT[unit](series.reduce((sum, s) => sum + Math.max(0, rows[i][s.key] ?? 0), 0)) }];
    },
  };
  return (
    <figure className="tr-chart">
      <Legend label={label} series={series} />
      <Plot label={label} summary={summary} scale={{ top, format: AXIS[unit] }} hover={hover}>
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
      <TimeAxis rows={rows} range={range} inset />
    </figure>
  );
}

/** How wide a bar label may be, in px per character (11px mono) plus padding. */
const CHAR_PX = 6.8;

/**
 * A distribution as bars, one per bucket (#1004): the empty buckets at the end are left out (but
 * never one a mark falls in), each bar is labelled with its count above it and its range under it
 * (every k-th range when the bars are narrow), and `marks` draw dashed lines at p50, p95 and the
 * Apdex threshold, named in the legend with their values. Hovering a bar shows its range, its count
 * and its share of every counted value.
 */
export function Histogram({
  label,
  summary,
  buckets: all,
  unit,
  valueLabel = "Requests",
  marks = [],
}: {
  label: string;
  summary: string;
  buckets: readonly EdgedBucket[];
  unit: Unit;
  /** What a bar counts, for the tooltip. */
  valueLabel?: string;
  marks?: readonly Mark[];
}) {
  const buckets = trimHistogram(all, marks.map((m) => m.value));
  const rows = buckets.map((b) => ({ count: b.count }));
  const { top } = stackBars(rows, ["count"], 1, H);
  const total = all.reduce((sum, b) => sum + Math.max(0, b.count), 0);
  const shown = marks.flatMap((m) => {
    const at = bucketFraction(buckets, m.value);
    return at === null ? [] : [{ ...m, at }];
  });
  const hover: PlotHover = {
    count: buckets.length,
    noun: "range",
    title: (i) => buckets[i].label,
    rows: (i) => [
      { label: valueLabel, value: FORMAT[unit](buckets[i].count) },
      { label: "Share", value: formatPercent(total > 0 ? buckets[i].count / total : 0) },
    ],
  };
  return (
    <figure className={`tr-chart${shown.length ? " ep-hist--marks" : ""}`}>
      {shown.length ? (
        <ul className="tr-legend" aria-label={`${label} marks`}>
          {shown.map((m) => (
            <li key={m.key}>
              <span className={`tr-swatch ep-mark-swatch ep-mark--${m.key}`} aria-hidden="true" />
              {m.label} {m.text}
            </li>
          ))}
        </ul>
      ) : null}
      <Plot label={label} summary={summary} scale={{ top, format: AXIS[unit] }} hover={hover} overlay={(w) => <HistogramLabels bars={stackBars(rows, ["count"], w, H).bars} marks={shown} w={w} unit={unit} />}>
        {(w, active) => (
          <>
            {stackBars(rows, ["count"], w, H).bars.map((b) => (
              <g key={b.index} className="tr-bucket">
                <rect className={`tr-hit${active === b.index ? " is-on" : ""}`} x={b.x} y={0} width={b.w} height={H} />
                {b.segments.map((s) => (
                  <rect key={s.key} className="ep-c-bar" x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
                ))}
              </g>
            ))}
            {shown.map((m) => (
              <line key={m.key} className={`ep-mark ep-mark--${m.key}`} x1={m.at * w} x2={m.at * w} y1={0} y2={H} />
            ))}
          </>
        )}
      </Plot>
      <BarAxis labels={buckets.map((b) => b.label)} />
    </figure>
  );
}

/** Each bar's count above it (inside a bar that reaches the top), when the bars are wide enough, and each mark's tag. */
function HistogramLabels({ bars, marks, w, unit }: { bars: ReturnType<typeof stackBars<"count">>["bars"]; marks: readonly (Mark & { at: number })[]; w: number; unit: Unit }) {
  const slot = bars.length ? w / bars.length : w;
  const fits = (text: string) => text.length * CHAR_PX + 4 <= slot;
  // Each tag sits above the plot, right of its line; a tag too close to the next one goes left of
  // its line instead, and so does one at the right edge.
  const sorted = [...marks].sort((a, b) => a.at - b.at).map((m) => ({ ...m, x: m.at * w }));
  const tags = sorted.map((m, k) => ({ ...m, left: m.x > w - 34 || (k + 1 < sorted.length && sorted[k + 1].x - m.x < 34) }));
  return (
    <>
      {bars.map((b) => {
        const seg = b.segments[0];
        const text = AXIS[unit](b.total);
        if (!seg || !fits(text)) return null;
        const inside = seg.y < 18;
        return (
          <span key={b.index} className={`ep-bar-label${inside ? " ep-bar-label--in" : ""}`} style={{ left: b.x + b.w / 2, top: inside ? seg.y + 2 : seg.y - 2 }}>
            {text}
          </span>
        );
      })}
      {tags.map((m) => (
        <span key={m.key} className={`ep-mark-tag ep-mark--${m.key}${m.left ? " ep-mark-tag--end" : ""}`} style={{ left: m.x }}>
          {m.label}
        </span>
      ))}
    </>
  );
}

/** The ranges under a histogram's bars, centred on each; every k-th when the bars are narrow. */
function BarAxis({ labels }: { labels: readonly string[] }) {
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>();
  const n = labels.length;
  if (n === 0) return null;
  const width = measured ?? 960;
  const slot = width / n;
  const longest = Math.max(...labels.map((l) => l.length));
  const every = labelEvery(slot, longest * CHAR_PX + 8);
  // A label wider than its bar stays inside the axis at either end.
  const left = (i: number, l: string) => {
    const half = (l.length * CHAR_PX) / 2;
    return Math.min(Math.max((i + 0.5) * slot, half), Math.max(half, width - half));
  };
  return (
    <figcaption className="tr-axis-x tr-axis-x--ticks tr-axis-x--inset" aria-hidden="true">
      <span className="tr-axis-x__zone" />
      <div className="tr-axis-x__track" ref={ref}>
        {labels.map((l, i) =>
          i % every === 0 ? (
            <span key={l} className="tr-tick tr-tick--bar" style={{ left: left(i, l) }}>
              {l}
            </span>
          ) : null,
        )}
      </div>
    </figcaption>
  );
}
