"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatBucket, formatCount, sparklinePoints, stackBars } from "@/lib/consumers";
import type { QueryRange } from "@/lib/identity";
import { type StatusRow, formatLatency, latencyTop, linePath, plotWidth } from "@/lib/traffic";

/** The viewBox width drawn before the box is measured (server render), stretched by CSS. */
const FALLBACK_W = 960;
const H = 160;

/**
 * The measured width of an element, in CSS pixels, kept current with a ResizeObserver; null until
 * it is measured or while it measures zero (hidden). Read synchronously after layout, so the first
 * client paint already uses it. This replaces v1's recharts ResponsiveContainer, which rendered at
 * `width(-1)` and then late or blank.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(plotWidth(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The plot box: measures itself and gives its children the width to draw at. */
function Plot({ label, summary, top, children }: { label: string; summary: string; top: string; children: (w: number) => ReactNode }) {
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>();
  const w = measured ?? FALLBACK_W;
  return (
    <div className="tr-plot" ref={ref}>
      <span className="tr-axis-top" aria-hidden="true">
        {top}
      </span>
      <svg
        viewBox={`0 0 ${w} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}. ${summary}`}
        data-measured={measured ?? undefined}
      >
        <line className="tr-grid" x1="0" x2={w} y1={0.5} y2={0.5} />
        <line className="tr-grid" x1="0" x2={w} y1={H / 2} y2={H / 2} />
        <line className="tr-base" x1="0" x2={w} y1={H - 0.5} y2={H - 0.5} />
        {children(w)}
      </svg>
    </div>
  );
}

function TimeAxis({ rows, range }: { rows: { ts: string }[]; range: QueryRange }) {
  const firstTs = rows[0]?.ts;
  const lastTs = rows[rows.length - 1]?.ts;
  if (!firstTs || !lastTs) return null;
  return (
    <figcaption className="tr-axis-x" aria-hidden="true">
      <span>{formatBucket(firstTs, range)}</span>
      <span>{formatBucket(lastTs, range)}</span>
    </figcaption>
  );
}

type Status = "successful" | "client_errors" | "server_errors";
const STATUS: readonly { key: Status; label: string; className: string }[] = [
  { key: "successful", label: "Successful", className: "tr-fill-ok" },
  { key: "client_errors", label: "4xx", className: "tr-fill-4xx" },
  { key: "server_errors", label: "5xx", className: "tr-fill-5xx" },
];

/**
 * Requests over time stacked by status class (successful, 4xx, 5xx), one bar per bucket. Every
 * bucket has a full-height hover target whose `<title>` lists its values, and the legend names
 * every series, so no series is told apart by color alone.
 */
export function StatusChart({ label, summary, rows, range }: { label: string; summary: string; rows: StatusRow[]; range: QueryRange }) {
  const keys = STATUS.map((s) => s.key);
  const className = Object.fromEntries(STATUS.map((s) => [s.key, s.className])) as Record<Status, string>;
  const tip = (r: StatusRow) =>
    [formatBucket(r.ts, range), ...STATUS.map((s) => `${s.label}: ${formatCount(r[s.key])}`)].join("\n");
  const { top } = stackBars(rows, keys, FALLBACK_W, H);
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        {STATUS.map((s) => (
          <li key={s.key}>
            <span className={`tr-swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <Plot label={label} summary={summary} top={formatCount(top)}>
        {(w) =>
          stackBars(rows, keys, w, H).bars.map((b) => (
            <g key={b.index} className="tr-bucket">
              <rect className="tr-hit" x={b.x} y={0} width={b.w} height={H}>
                <title>{tip(rows[b.index])}</title>
              </rect>
              {b.segments.map((s) => (
                <rect key={s.key} className={className[s.key]} x={b.x} y={s.y} width={b.w} height={s.h} rx={b.w >= 6 ? 2 : 0} />
              ))}
            </g>
          ))
        }
      </Plot>
      <TimeAxis rows={rows} range={range} />
    </figure>
  );
}

/** p95 latency over time as a line, one point per bucket, with a hover target per bucket. */
export function LatencyChart({ label, summary, rows, range }: { label: string; summary: string; rows: { ts: string; p95_ms: number }[]; range: QueryRange }) {
  const values = rows.map((r) => r.p95_ms);
  const top = latencyTop(values);
  return (
    <figure className="tr-chart">
      <ul className="tr-legend" aria-label={`${label} legend`}>
        <li>
          <span className="tr-swatch tr-fill-line" aria-hidden="true" />
          p95
        </li>
      </ul>
      <Plot label={label} summary={summary} top={formatLatency(top)}>
        {(w) => {
          const slot = rows.length ? w / rows.length : w;
          return (
            <>
              {rows.map((r, i) => (
                <rect key={r.ts} className="tr-hit" x={i * slot} y={0} width={slot} height={H}>
                  <title>{`${formatBucket(r.ts, range)}\np95: ${formatLatency(r.p95_ms)}`}</title>
                </rect>
              ))}
              <path className="tr-line" d={linePath(values, w, H, top)} />
            </>
          );
        }}
      </Plot>
      <TimeAxis rows={rows} range={range} />
    </figure>
  );
}

/** A tile's recent history as a small line; decorative (the tile has the number). */
export function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length === 0) return <span className="tr-spark" aria-hidden="true" />;
  return (
    <svg className="tr-spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={sparklinePoints(values, 120, 24)} />
    </svg>
  );
}
