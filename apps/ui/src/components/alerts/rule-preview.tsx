"use client";

// The rule editor's preview strip (#982): the rule's metric over the last 24 hours of its app and
// environment, one bar per bucket, against the dashed threshold line, and how many times the rule
// would have breached. The series loads (debounced) when the app or environment changes; the
// threshold, condition and window recompute it in place.
import { type ReactNode, useEffect, useState } from "react";
import { loadRulePreview } from "@/app/project/[project]/incidents/rules/preview-actions";
import { conditionText, formatMetric, metricLabel } from "@/lib/alerts";
import { niceMax } from "@/lib/consumers";
import type { AlertCondition, AlertMetric, TrafficPoint } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { PREVIEW_DEBOUNCE_MS, breachCount, breachText, breachedBuckets, hasPreview, isScaledCount, previewValues } from "@/lib/rule-preview";
import { useTimeZone } from "@/lib/time-zone-context";
import "./rule-preview.css";

const W = 600;
const H = 80;

type Series = { key: string; state: "ready"; bucket_seconds: number; points: TrafficPoint[] } | { key: string; state: "error"; error: string };

export function RulePreview({
  project,
  appId,
  environment,
  metric,
  condition,
  threshold,
  windowSeconds,
  filtered,
}: {
  project: string;
  appId: string;
  environment: string;
  metric: AlertMetric;
  condition: AlertCondition;
  /** In API units; null while the field is not a number. */
  threshold: number | null;
  windowSeconds: number | null;
  /** The rule narrows to an endpoint, consumer or group, which the preview does not. */
  filtered: boolean;
}) {
  const env = environment.trim();
  const key = `${appId}\n${env}`;
  const [series, setSeries] = useState<Series | null>(null);
  const charted = hasPreview(metric);

  useEffect(() => {
    if (!appId || !charted) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await loadRulePreview(project, appId, env);
      if (!live) return;
      setSeries(r.ok ? { key, state: "ready", bucket_seconds: r.bucket_seconds, points: r.points } : { key, state: "error", error: r.error });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [project, appId, env, key, charted]);

  let body: ReactNode;
  if (!charted) {
    body = <p className="al-hint">No preview for {metricLabel(metric)} yet; the rule checks it against live data once saved.</p>;
  } else if (!appId) {
    body = <p className="al-hint">Pick an app to preview the threshold against its last 24 hours.</p>;
  } else if (!series || series.key !== key) {
    body = (
      <p className="al-hint" aria-busy="true">
        Loading the last 24 hours…
      </p>
    );
  } else if (series.state === "error") {
    body = <p className="ob-err">{series.error}</p>;
  } else if (series.points.length === 0 || (metric !== "traffic" && series.points.every((p) => p.requests <= 0))) {
    body = <p className="al-hint">No traffic from this app{env ? ` in ${env}` : ""} in the last 24 hours, so there is nothing to preview yet.</p>;
  } else {
    body = <PreviewChart metric={metric} condition={condition} threshold={threshold} windowSeconds={windowSeconds} bucketSeconds={series.bucket_seconds} points={series.points} filtered={filtered} />;
  }

  return (
    <section className="rp" aria-label="Preview">
      <h3 className="rp-h">Preview, last 24 hours</h3>
      {body}
    </section>
  );
}

function PreviewChart({
  metric,
  condition,
  threshold,
  windowSeconds,
  bucketSeconds,
  points,
  filtered,
}: {
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: number | null;
  windowSeconds: number | null;
  bucketSeconds: number;
  points: TrafficPoint[];
  filtered: boolean;
}) {
  const tz = useTimeZone();
  const values = previewValues(metric, points, bucketSeconds, windowSeconds ?? bucketSeconds);
  const flags = threshold === null ? values.map(() => false) : breachedBuckets(values, condition, threshold);
  const count = breachCount(flags);
  const n = values.length;
  const raw = Math.max(threshold ?? 0, ...values.map((v) => v ?? 0)) * 1.1;
  const top = raw <= 0 ? 1 : raw < 1 ? niceMax(raw * 100) / 100 : niceMax(raw);
  const y = (v: number) => H - (Math.max(0, v) / top) * H;
  const slot = W / Math.max(1, n);
  const gap = slot > 4 ? 1 : 0;
  const limit = threshold === null ? "" : conditionText(metric, condition, threshold);
  const bucketMin = Math.round(bucketSeconds / 60);
  return (
    <figure className="rp-chart">
      <p className="rp-count" role="status" aria-live="polite">
        {threshold === null ? "Enter a threshold to see how often it would have breached." : `${breachText(count)}.`}
      </p>
      <ul className="al-legend rp-legend" aria-hidden="true">
        <li>
          <span className="al-swatch al-c-open" />
          Breached
        </li>
        <li>
          <span className="al-swatch al-c-resolved" />
          Within
        </li>
        {threshold !== null ? (
          <li>
            <span className="al-swatch-threshold" />
            Threshold {limit}
          </li>
        ) : null}
      </ul>
      <div className="rp-box" role="img" aria-label={`${metricLabel(metric)} per ${bucketMin} minutes over the last 24 hours${limit ? `, breaching at ${limit}` : ""}: ${breachText(count).toLowerCase()}.`}>
        <span className="rp-top" aria-hidden="true">
          {formatMetric(metric, top)}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="al-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
          {values.map((v, k) => {
            if (v === null) return null;
            const h = Math.max(1, H - y(v));
            return <rect key={points[k].ts} className={flags[k] ? "al-c-open" : "al-c-resolved"} x={k * slot + gap / 2} y={H - h} width={Math.max(0.5, slot - gap)} height={h} />;
          })}
          {threshold !== null ? <line className="al-threshold" x1={0} x2={W} y1={y(threshold)} y2={y(threshold)} /> : null}
        </svg>
      </div>
      <figcaption className="al-axis" aria-hidden="true">
        <span>{formatExact(points[0].ts, tz)}</span>
        <span>{formatExact(points[n - 1].ts, tz)}</span>
      </figcaption>
      <p className="al-hint">
        One bar per {bucketMin} min
        {isScaledCount(metric) && windowSeconds ? `, counts scaled to the ${Math.round(windowSeconds / 60)} min window` : ""}.
        {filtered ? " Covers every request of the app in this environment; the endpoint and consumer filters are not applied." : ""}
      </p>
    </figure>
  );
}
