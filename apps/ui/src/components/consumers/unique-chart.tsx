"use client";

import { chartPeriod, chartTick, chartTooltipLabel } from "@/lib/explore-timeline";
import { useTimeZone } from "@/lib/time-zone-context";

type Point = { ts: string; consumers: number; new: number; returning: number };

/** How many time labels the axis shows, spread inside the edges. */
const TICKS = 6;

/**
 * Unique users per bucket at Explore's chart position and size (the `.exc` row, 60px): returning
 * users in grey with the new ones (first seen in that bucket) stacked on top in the accent. Each
 * bar's title reads its bucket and counts; the axis labels sit inside the plot's edges.
 */
export function UniqueChart({ points }: { points: readonly Point[] }) {
  const tz = useTimeZone();
  if (points.length === 0) return <section className="exc" aria-label="No users over time" />;
  const at = points.map((p) => Date.parse(p.ts));
  const period = chartPeriod(Math.abs(at[at.length - 1] - at[0]));
  const top = Math.max(1, ...points.map((p) => p.consumers));
  const ticks = Array.from({ length: TICKS }, (_, k) => Math.round(((k + 0.5) * (points.length - 1)) / TICKS));
  return (
    <section className="exc cs-chart" aria-label={`Unique users over time: ${points.reduce((n, p) => Math.max(n, p.consumers), 0)} at most in one bucket`}>
      <div className="cs-plot">
        {points.map((p, i) => {
          const label = `${chartTooltipLabel(at[i], period, tz)}: ${p.consumers} ${p.consumers === 1 ? "user" : "users"} (${p.new} new, ${p.returning} returning)`;
          return (
            <span key={p.ts} className="cs-bar" title={label} style={{ height: `${(p.consumers / top) * 100}%` }}>
              <span className="cs-bar__new" style={{ height: `${p.consumers ? (p.new / p.consumers) * 100 : 0}%` }} />
            </span>
          );
        })}
      </div>
      <div className="cs-axis" aria-hidden="true">
        {ticks.map((i) => (
          <span key={i} style={{ left: `${((i + 0.5) / points.length) * 100}%` }}>
            {chartTick(at[i], period, tz)}
          </span>
        ))}
      </div>
    </section>
  );
}
