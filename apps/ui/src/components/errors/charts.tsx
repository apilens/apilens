"use client";

// The Errors page's bar charts (#594) on the Traffic page's measured plot box, with the shared
// chart hover (components/charts): hovering, tapping or arrowing through a bucket shows its time
// and every series' exact count in a tooltip, and reads it to screen readers.
import { pointX, tooltipText } from "@/lib/chart-hover";
import { formatBucket, formatCount, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";
import { PLOT_HEIGHT as H, Plot, TimeAxis } from "../traffic/charts";

export interface BarSeries<K extends string> {
  key: K;
  label: string;
  /** Fill class from errors.css (`er-c-4xx`, `er-c-5xx`), also the legend and tooltip swatch. */
  className: string;
}

type Row<K extends string> = { ts: string } & Record<K, number>;

/**
 * Counts over time as stacked bars, one bar per bucket, with a legend naming every series (so no
 * series is told apart by color alone) and the shared hover tooltip listing each series' count and,
 * with more than one series, their total.
 */
export function CountBars<K extends string>({
  label,
  summary,
  rows,
  series,
  range,
}: {
  label: string;
  summary: string;
  rows: readonly Row<K>[];
  series: readonly BarSeries<K>[];
  range: QueryRange;
}) {
  const keys = series.map((s) => s.key);
  const className = Object.fromEntries(series.map((s) => [s.key, s.className])) as Record<K, string>;
  const n = rows.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const { top } = stackBars([...rows], keys, 1, H);
  const row = i !== null ? rows[i] : null;
  const title = row ? formatBucket(row.ts, range) : "";
  const tipRows = row
    ? [
        ...series.map((s) => ({ label: s.label, value: formatCount(row[s.key]), swatch: s.className })),
        ...(series.length > 1 ? [{ label: "Total", value: formatCount(keys.reduce((sum, k) => sum + row[k], 0)) }] : []),
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
