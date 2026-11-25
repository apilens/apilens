"use client";

import { useTimeZone } from "@/lib/time-zone-context";

import { formatBucket, formatCount, niceMax } from "@/lib/consumers";
import type { QueryRange, ResourceSeries, ResourceUnit } from "@/lib/identity";
import { type ChartMarker, bucketOf, formatResource, timeX, unitTop } from "@/lib/resources";
import { lineY } from "@/lib/traffic";
import type { TooltipRow } from "../charts/chart-tooltip";
import { BandMarks, GapLine, LimitLine, LineMarks, Markers, PLOT_HEIGHT, Plot, type PlotHover, TimeAxis } from "../traffic/charts";

const MARKER_SWATCH = { oom: "tr-fill-oom", restart: "tr-fill-restart", deploy: "tr-fill-deploy" } as const;
const MARKER_NAME = { oom: "OOM", restart: "Restart", deploy: "Deploy" } as const;

/**
 * One resources chart (M7 D15): the average over instances as a line with the min–max band behind
 * it, gaps where no heartbeat landed, an optional limit line, requests per minute on a second axis
 * and restart / OOM / deploy markers. Hovering, tapping or arrowing to a bucket reads its average,
 * min, max, instance count, traffic and the events in it.
 */
export function ResourceChart({
  label,
  series,
  range,
  markers = [],
  overlay = null,
  showLimit = false,
  limitLabel = "Limit",
}: {
  label: string;
  series: ResourceSeries;
  range: QueryRange;
  markers?: readonly ChartMarker[];
  /** Requests per minute per bucket (trafficOverlay), or null for none. */
  overlay?: readonly (number | null)[] | null;
  showLimit?: boolean;
  limitLabel?: string;
}) {
  const tz = useTimeZone();
  const points = series.points ?? [];
  const unit: ResourceUnit = series.unit;
  const avg = points.map((p) => p.avg);
  const min = points.map((p) => p.min);
  const max = points.map((p) => p.max);
  const limit = showLimit && series.limit !== null && series.limit > 0 ? series.limit : null;
  const top = unitTop(unit, max, limit);
  const trafficTop = overlay ? niceMax(Math.max(0, ...overlay.filter((v): v is number => v !== null))) : 0;
  const hasOverlay = overlay !== null && overlay.some((v) => v !== null);
  const rows = points.map((p) => ({ ts: p.t }));
  const byBucket = new Map<number, ChartMarker[]>();
  for (const m of markers) {
    const i = bucketOf(m.at, points, series.bucket_seconds);
    if (i !== null) byBucket.set(i, [...(byBucket.get(i) ?? []), m]);
  }
  const kinds = [...new Set([...byBucket.values()].flat().map((m) => m.kind))];

  const tipRows = (i: number): TooltipRow[] => {
    const p = points[i];
    const out: TooltipRow[] =
      p.avg === null
        ? [{ label: "No data", value: "no heartbeat landed" }]
        : [
            { label: "Average", value: formatResource(unit, p.avg), swatch: "tr-sw-line" },
            { label: "Min to max", value: `${formatResource(unit, p.min)} to ${formatResource(unit, p.max)}`, swatch: "tr-fill-band" },
            { label: "Instances", value: formatCount(p.instances) },
          ];
    if (limit !== null) out.push({ label: limitLabel, value: formatResource(unit, limit) });
    if (hasOverlay && overlay) out.push({ label: "Requests/min", value: overlay[i] === null ? "no data" : formatCount(Math.round(overlay[i] as number)), swatch: "tr-fill-overlay" });
    for (const m of byBucket.get(i) ?? []) out.push({ label: MARKER_NAME[m.kind], value: m.label, swatch: MARKER_SWATCH[m.kind] });
    return out;
  };

  const known = avg.filter((v): v is number => v !== null);
  const peak = Math.max(...max.filter((v): v is number => v !== null));
  const summary =
    known.length === 0
      ? "No samples in this range."
      : `Latest average ${formatResource(unit, known[known.length - 1])}, peak ${formatResource(unit, peak)} over ${formatCount(points.length)} buckets${
          markers.length ? `, ${markers.length} ${markers.length === 1 ? "event" : "events"} marked` : ""
        }.`;

  const hover: PlotHover = {
    count: points.length,
    title: (i) => formatBucket(points[i].t, range, tz),
    rows: tipRows,
    marks: (i, w) => {
      const v = avg[i];
      return <LineMarks i={i} count={points.length} w={w} dots={v === null ? [] : [{ y: lineY(v, PLOT_HEIGHT, top), className: "tr-dot--accent" }]} />;
    },
  };

  return (
    <figure className="tr-chart rs-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        <li>
          <span className="tr-swatch tr-fill-line" aria-hidden="true" />
          Average
        </li>
        <li>
          <span className="tr-swatch tr-fill-band" aria-hidden="true" />
          Min to max across instances
        </li>
        {limit !== null ? (
          <li>
            <span className="tr-swatch tr-fill-limit" aria-hidden="true" />
            {limitLabel} {formatResource(unit, limit)}
          </li>
        ) : null}
        {hasOverlay ? (
          <li>
            <span className="tr-swatch tr-fill-overlay" aria-hidden="true" />
            Requests/min (left axis)
          </li>
        ) : null}
        {kinds.map((k) => (
          <li key={k}>
            <span className={`tr-swatch ${MARKER_SWATCH[k]}`} aria-hidden="true" />
            {MARKER_NAME[k]}
          </li>
        ))}
      </ul>
      <Plot label={label} summary={summary} top={formatResource(unit, top)} topLeft={hasOverlay ? `${formatCount(trafficTop)} req/min` : undefined} hover={hover}>
        {(w, active) => {
          const slot = points.length ? w / points.length : w;
          const plotted = markers.flatMap((m) => {
            const x = timeX(m.at, points, series.bucket_seconds, w);
            return x === null ? [] : [{ x, kind: m.kind, label: m.label }];
          });
          return (
            <>
              {points.map((p, i) => (
                <rect key={p.t} className={`tr-hit${active === i ? " is-on" : ""}`} x={i * slot} y={0} width={slot} height={PLOT_HEIGHT} />
              ))}
              {hasOverlay && overlay ? <GapLine values={overlay} w={w} top={trafficTop} className="tr-line--overlay" /> : null}
              <BandMarks min={min} max={max} w={w} top={top} />
              {limit !== null ? <LimitLine value={limit} w={w} top={top} /> : null}
              <GapLine values={avg} w={w} top={top} />
              <Markers markers={plotted} />
            </>
          );
        }}
      </Plot>
      <TimeAxis rows={rows} range={range} />
    </figure>
  );
}
