"use client";

// The Errors page's bar charts (#594) on the Traffic page's measured plot box, with the shared
// chart hover (components/charts): hovering, tapping or arrowing through a bucket shows its time
// and every series' exact count in a tooltip, and reads it to screen readers.
import { pointX, tooltipText } from "@/lib/chart-hover";
import { formatBucket, formatCount, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { formatRateTop } from "@/lib/errors";
import { formatPercent } from "@/lib/format";
import { lineY, linePath } from "@/lib/traffic";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";
import { PLOT_HEIGHT as H, Plot, TimeAxis } from "../traffic/charts";
import { useTimeZone } from "@/lib/time-zone-context";

export interface BarSeries<K extends string> {
  key: K;
  label: string;
  /** Fill class from errors.css (`er-c-4xx`, `er-c-5xx`), also the legend and tooltip swatch. */
  className: string;
}

type Row<K extends string> = { ts: string } & Record<K, number>;

/**
 * A rate drawn as a line over the bars on its own scale (#1002), such as the error rate over the
 * error counts: one rate (0–1) per row, scaled from 0 at the baseline to `top` at the plot's top,
 * which the legend names (`Error rate (0–5%)`). Plain data, so a Server Component can pass it.
 */
export interface RateLine {
  label: string;
  values: readonly number[];
  top: number;
}

/**
 * Counts over time as stacked bars, one bar per bucket, with a legend naming every series (so no
 * series is told apart by color alone) and the shared hover tooltip listing each series' count and,
 * with more than one series, their total. With `line`, a line on its own scale runs over the bars,
 * and the legend (with its scale) and the tooltip name it too.
 */
export function CountBars<K extends string>({
  label,
  summary,
  rows,
  series,
  range,
  line,
}: {
  label: string;
  summary: string;
  rows: readonly Row<K>[];
  series: readonly BarSeries<K>[];
  range: QueryRange;
  line?: RateLine;
}) {
  const tz = useTimeZone();
  const keys = series.map((s) => s.key);
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const n = rows.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const { top } = stackBars([...rows], keys, 1, H);
  const row = i !== null ? rows[i] : null;
  const title = row ? formatBucket(row.ts, range, tz) : "";
  const tipRows = row
    ? [
        ...series.map((s) => ({ label: s.label, value: formatCount(row[s.key]), swatch: s.className })),
        ...(series.length > 1 ? [{ label: "Total", value: formatCount(keys.reduce((sum, k) => sum + row[k], 0)) }] : []),
        ...(line && i !== null ? [{ label: line.label, value: formatPercent(line.values[i] ?? 0), swatch: "tr-sw-line" }] : []),
      ]
    : [];
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        {series.map((s) => (
          <li key={s.key}>
            <span className={`tr-swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
        {line ? (
          <li>
            <span className="tr-swatch tr-fill-line" aria-hidden="true" />
            {line.label} <span className="er-scale">(0–{formatRateTop(line.top)})</span>
          </li>
        ) : null}
      </ul>
      <div className="ct-box er-bars" ref={hover.ref} role="group" aria-label={`${label}. ${summary} Use the arrow keys to read each bucket.`} {...hover.bind}>
        <Plot label={label} summary={summary} top={formatCount(top)}>
          {(w) => {
            const { bars } = stackBars([...rows], keys, w, H);
            const slot = n ? w / n : w;
            return (
              <>
                {i !== null ? <rect className="ct-bar-hover" x={i * slot} y={0} width={slot} height={H} /> : null}
                {bars.map((b) => (
                  <g key={b.index}>
                    {b.segments.map((s) => (
                      <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
                    ))}
                  </g>
                ))}
                {line ? <path className="tr-line er-rate-line" d={linePath(line.values, w, H, line.top)} /> : null}
                {line && i !== null ? (
                  <circle className="ct-dot tr-dot tr-dot--accent" cx={i * slot + slot / 2} cy={lineY(line.values[i] ?? 0, H, line.top)} r={3.5} aria-hidden="true" />
                ) : null}
              </>
            );
          }}
        </Plot>
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={tipRows} placement="inside" /> : null}
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, tipRows) : ""} />
      <TimeAxis rows={[...rows]} range={range} />
    </figure>
  );
}
