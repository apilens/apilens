// The incident detail's metric chart (#980): the rule's metric over the last hours of its app and
// environment, from `GET /traffic/timeseries`, against the threshold, with each incident shaded.
// Pure helpers, unit-tested in incident-metric.test.ts.
import { formatSpan, metricLabel } from "./alerts";
import { ratio } from "./format";
import type { AlertEvent, AlertMetric, AlertRule, TrafficPoint } from "./identity";

const HOUR = 3_600_000;

/**
 * The range the chart reads: the last 6 hours, or 24 when the newest incident on the page started
 * before them (so its band is in view). `newest` is the newest incident's start, if any.
 */
export function chartRange(newest: string | undefined, now: number): "6h" | "24h" {
  const t = newest ? Date.parse(newest) : Number.NaN;
  return !Number.isNaN(t) && now - t > 6 * HOUR ? "24h" : "6h";
}

/** How a metric reads off a traffic bucket; absent for metrics the series does not carry. */
const SERIES: Partial<Record<AlertMetric, { kind: "count" | "rate" | "ms"; of: (p: TrafficPoint) => number }>> = {
  traffic: { kind: "count", of: (p) => p.requests },
  errors: { kind: "count", of: (p) => p.client_errors + p.server_errors },
  server_errors: { kind: "count", of: (p) => p.server_errors },
  client_errors: { kind: "count", of: (p) => p.client_errors },
  error_rate: { kind: "rate", of: (p) => ratio(p.client_errors + p.server_errors, p.requests) },
  server_error_rate: { kind: "rate", of: (p) => ratio(p.server_errors, p.requests) },
  client_error_rate: { kind: "rate", of: (p) => ratio(p.client_errors, p.requests) },
  p95: { kind: "ms", of: (p) => p.p95_ms },
};

/** True when the traffic series carries `metric` (p50, p75, Apdex and unique consumers it does not). */
export const hasSeries = (metric: AlertMetric): boolean => SERIES[metric] !== undefined;

/**
 * The rule's metric per bucket, oldest first, comparable with its threshold: rates and p95 as the
 * bucket has them; counts scaled from the bucket to the rule's window (a 15 min bucket of 300
 * errors is 100 per 5 min window), so a count threshold over 5 min lines up. Null when the series
 * does not carry the metric.
 */
export function metricValues(metric: AlertMetric, points: readonly TrafficPoint[], bucketSeconds: number, windowSeconds: number): number[] | null {
  const s = SERIES[metric];
  if (!s) return null;
  const scale = s.kind === "count" && bucketSeconds > 0 && windowSeconds > 0 ? windowSeconds / bucketSeconds : 1;
  return points.map((p) => {
    const v = s.of(p) * scale;
    return Number.isFinite(v) ? v : 0;
  });
}

/** What the plotted line is called: the metric, and for counts the window it is counted over. */
export function seriesLabel(rule: Pick<AlertRule, "metric" | "window_s">): string {
  return SERIES[rule.metric]?.kind === "count" ? `${metricLabel(rule.metric)} per ${formatSpan(rule.window_s)}` : metricLabel(rule.metric);
}

/** Why there is no chart for a metric the series does not carry. */
export const noSeriesText = (metric: AlertMetric): string =>
  `${metricLabel(metric)} has no series over time yet, so there is no chart for this rule. Each incident’s value is in the timeline below.`;

/** An incident's band as fractions (0..1) of the plotted span. */
export interface Band {
  id: string;
  from: number;
  to: number;
  open: boolean;
}

/**
 * Each incident that overlaps the plotted span [`from`, `to`) (ms), from its start to its end, or
 * to `now` while it is open, clipped to the span, oldest first.
 */
export function incidentBands(events: readonly Pick<AlertEvent, "id" | "started_at" | "ended_at">[], from: number, to: number, now: number): Band[] {
  if (!(to > from)) return [];
  const out: Band[] = [];
  for (const e of events) {
    const s = Date.parse(e.started_at);
    const end = e.ended_at ? Date.parse(e.ended_at) : now;
    if (Number.isNaN(s) || Number.isNaN(end) || end < from || s >= to) continue;
    const a = (Math.max(s, from) - from) / (to - from);
    const b = (Math.min(Math.max(end, s), to) - from) / (to - from);
    out.push({ id: e.id, from: a, to: b, open: !e.ended_at });
  }
  return out.reverse();
}

/** The plotted span in ms: from the first bucket's start to the last bucket's end; null without points. */
export function plotSpan(points: readonly Pick<TrafficPoint, "ts">[], bucketSeconds: number): { from: number; to: number } | null {
  if (points.length === 0) return null;
  const from = Date.parse(points[0].ts);
  const last = Date.parse(points[points.length - 1].ts);
  if (Number.isNaN(from) || Number.isNaN(last)) return null;
  return { from, to: last + Math.max(0, bucketSeconds) * 1000 };
}
