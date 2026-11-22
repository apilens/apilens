"use client";

import { pointX, tooltipText } from "@/lib/chart-hover";
import { formatBucket, formatCount, sparklinePoints } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { ChartAnnounce, ChartTooltip, Crosshair } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";
import { useTimeZone } from "@/lib/time-zone-context";

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
  const tz = useTimeZone();
  const n = values.length;
  const hover = useChartHover<HTMLDivElement>(n, "point");
  const i = hover.index;
  const max = Math.max(...values, 0);
  // The same y as sparklinePoints, in px (the box is SPARK_H px tall).
  const y = (val: number) => (max > 0 ? SPARK_H - 1 - (val / max) * (SPARK_H - 2) : SPARK_H - 1);
  const title = i !== null ? formatBucket(times[i], range, tz) : "";
  const rows = i !== null ? [{ label: "Requests", value: formatCount(values[i]) }] : [];
  const peak = values.indexOf(max);
  return (
    <>
      <div
        ref={hover.ref}
        className="cs-spark ct-box"
        role="group"
        aria-label={`Requests over time for ${name}, peaking at ${formatCount(max)} (${formatBucket(times[peak], range, tz)}). Use the arrow keys to read each bucket.`}
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
