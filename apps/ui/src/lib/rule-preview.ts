// The rule editor's preview (#982): the rule's metric over the last 24 hours of its app and
// environment (`GET /traffic/timeseries`), checked against the threshold being typed, and the
// environment typo check. Pure helpers, unit-tested in rule-preview.test.ts.
import type { AlertCondition, AlertMetric, QueryRange, TrafficPoint } from "./identity";
import { hasSeries, metricValues } from "./incident-metric";

/** How far back the preview looks. */
export const PREVIEW_RANGE: QueryRange = "24h";
/** How long the editor waits after the app or environment changes before it loads the preview. */
export const PREVIEW_DEBOUNCE_MS = 400;

/** Whether the preview can chart `metric`: p50, p75, Apdex and unique consumers have no series. */
export const hasPreview = (metric: AlertMetric): boolean => hasSeries(metric);

const COUNTS = new Set<AlertMetric>(["traffic", "errors", "server_errors", "client_errors"]);

/** Whether a count metric is scaled from the bucket to the rule's window. */
export const isScaledCount = (metric: AlertMetric): boolean => COUNTS.has(metric);

/**
 * The metric per bucket, oldest first, as the incident chart reads it (`metricValues`, #980):
 * counts scaled from the bucket to the rule's window, so `errors > 10` over 5 minutes reads against
 * a 30 minute bucket as its average 5 minutes. A rate or p95 is null in a bucket without requests,
 * so an empty bucket never breaches.
 */
export function previewValues(metric: AlertMetric, points: readonly TrafficPoint[], bucketSeconds: number, windowSeconds: number): (number | null)[] {
  const values = metricValues(metric, points, bucketSeconds, windowSeconds);
  if (!values) return [];
  return values.map((v, i) => (!COUNTS.has(metric) && points[i].requests <= 0 ? null : v));
}

/** Whether `value` breaches `condition` against `threshold`. */
export function breaches(condition: AlertCondition, value: number, threshold: number): boolean {
  switch (condition) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/** Which buckets breach; a bucket without a value never does. */
export function breachedBuckets(values: readonly (number | null)[], condition: AlertCondition, threshold: number): boolean[] {
  return values.map((v) => v !== null && breaches(condition, v, threshold));
}

/** How many times the rule would have breached: each run of breaching buckets counts once. */
export function breachCount(flags: readonly boolean[]): number {
  let n = 0;
  flags.forEach((f, i) => {
    if (f && !flags[i - 1]) n++;
  });
  return n;
}

/** `Would have breached 3 times in the last 24 hours`, or that it would not have. */
export function breachText(n: number): string {
  if (n <= 0) return "Would not have breached in the last 24 hours";
  return `Would have breached ${n === 1 ? "once" : `${n} times`} in the last 24 hours`;
}

/** Edit distance between two strings (Levenshtein). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The known environment closest to `env` (ignoring case); ties go to production, then the list order. */
export function closestEnvironment(env: string, known: readonly string[]): string | null {
  const e = env.trim().toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of [...known].sort((a, b) => Number(b === "production") - Number(a === "production"))) {
    const d = distance(e, k.toLowerCase());
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/**
 * The non-blocking warning for an environment no traffic was seen from (#982): `No traffic seen
 * from prodution; did you mean production?`. Null when it is blank or known, or nothing is known.
 */
export function environmentWarning(env: string, known: readonly string[]): string | null {
  const e = env.trim();
  if (e === "" || known.length === 0 || known.includes(e)) return null;
  const guess = closestEnvironment(e, known);
  return `No traffic seen from ${e}; did you mean ${guess}?`;
}
