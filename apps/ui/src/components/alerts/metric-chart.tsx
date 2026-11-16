"use client";

// The incident detail's metric chart (#980): the rule's metric over the last 6 (or 24) hours of
// its app and environment as a line, the threshold dashed, and each incident shaded from its start
// to its end (or now). Hovering, tapping or arrowing through a bucket shows its time, value and the
// threshold, with the shared chart hover (components/charts).
import { pointX, tooltipText } from "@/lib/chart-hover";
import { conditionText, formatMetric } from "@/lib/alerts";
import { formatBucket, niceMax } from "@/lib/consumers";
import type { AlertEvent, AlertRule, TrafficTimeseries } from "@/lib/identity";
import { incidentBands, metricValues, plotSpan, seriesLabel } from "@/lib/incident-metric";
import { linePath, lineY } from "@/lib/traffic";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";

const W = 600;
const H = 140;

/**
 * `series` is the timeseries of the rule's app and environment over `range`; `events` the page's
 * incidents, newest first; `now` the load time (the end of an open incident's band). The caller
 * checks the metric has a series (hasSeries) and the series has points.
 */
export function MetricChart({
  rule,
  series,
  events,
  range,
  now,
}: {
  rule: Pick<AlertRule, "metric" | "condition" | "threshold" | "window_s">;
  series: TrafficTimeseries;
  events: readonly AlertEvent[];
  range: "6h" | "24h";
  now: number;
}) {
  const points = series.points ?? [];
  const values = metricValues(rule.metric, points, series.bucket_seconds, rule.window_s) ?? [];
  const n = values.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  // A round top above the highest value and the threshold; rates (0..1) round in hundredths.
  const raw = Math.max(rule.threshold, ...values) * 1.1;
  const top = raw > 0 && raw < 1 ? niceMax(raw * 100) / 100 : niceMax(raw);
  const span = plotSpan(points, series.bucket_seconds);
  const bands = span ? incidentBands(events, span.from, span.to, now) : [];
  const slot = n ? W / n : W;
  const label = seriesLabel(rule);
  const threshold = conditionText(rule.metric, rule.condition, rule.threshold);
  const title = i !== null ? formatBucket(points[i].ts, range) : "";
  const tipRows =
    i !== null
      ? [
          { label, value: formatMetric(rule.metric, values[i]), swatch: "al-sw-line" },
          { label: "Threshold", value: threshold },
        ]
      : [];
  const hours = range === "24h" ? "24 hours" : "6 hours";
  const peak = n ? Math.max(...values) : 0;
  const summary = `${label} over the last ${hours}, peak ${formatMetric(rule.metric, peak)}, threshold ${threshold}, ${bands.length} ${bands.length === 1 ? "incident" : "incidents"} shaded.`;
  return (
    <figure className="al-chart al-metric">
      <ul className="al-legend" aria-label={`${label} legend`}>
        <li>
          <span className="al-swatch-line" aria-hidden="true" />
          {label}
        </li>
        <li>
          <span className="al-swatch-threshold" aria-hidden="true" />
          Threshold {threshold}
        </li>
        <li>
          <span className="al-swatch al-band" aria-hidden="true" />
          Incident
        </li>
      </ul>
      <div className="ct-box al-chart__box" ref={hover.ref} role="group" aria-label={`${summary} Use the arrow keys to read each bucket.`} {...hover.bind}>
        <span className="al-chart__top" aria-hidden="true">
          {formatMetric(rule.metric, top)}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {bands.map((b) => (
            <rect key={b.id} className="al-band" data-open={b.open || undefined} x={b.from * W} y={0} width={Math.max(1, (b.to - b.from) * W)} height={H} />
          ))}
          <line className="al-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
          {i !== null ? <rect className="ct-bar-hover" x={i * slot} y={0} width={slot} height={H} /> : null}
          <path className="al-line" d={linePath(values, W, H, top)} />
          <line className="al-threshold" x1={0} x2={W} y1={lineY(rule.threshold, H, top)} y2={lineY(rule.threshold, H, top)} />
        </svg>
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={tipRows} placement="inside" /> : null}
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, tipRows) : ""} />
      <figcaption className="al-axis" aria-hidden="true">
        <span>{points[0] ? formatBucket(points[0].ts, range) : ""}</span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}
