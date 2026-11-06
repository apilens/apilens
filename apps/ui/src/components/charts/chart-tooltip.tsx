"use client";

// Shared chart tooltip. Import:
//   import { ChartAnnounce, ChartTooltip, Crosshair, type TooltipRow } from "@/components/charts/chart-tooltip";
//   import { useChartHover } from "@/components/charts/use-chart-hover";
//   import { pointX, tooltipText } from "@/lib/chart-hover";
// ChartTooltip props: x (px from the box's left), boxWidth (px), title, rows ({ label, value, swatch? }[]),
// placement? ("above" | "inside"). ChartAnnounce props: text. Crosshair props: x, height (viewBox units).
// Reference use: Sparkline in components/traffic/charts.tsx (Traffic Requests tile).
//
//   const hover = useChartHover<HTMLDivElement>(rows.length, "slot");   // "point" for lines
//   const i = hover.index;
//   <div className="ct-box" ref={hover.ref} {...hover.bind} role="group" aria-label="Requests by status">
//     <svg>...bars...{i !== null ? <rect className="ct-bar-hover" ... /> : null}</svg>
//     {i !== null ? <ChartTooltip x={pointX(i, hover.width, rows.length, "slot")} boxWidth={hover.width}
//        title={formatBucket(rows[i].ts, range)} rows={[{ label: "5xx", value: formatCount(rows[i].server_errors), swatch: "tr-fill-5xx" }]} /> : null}
//   </div>
//   <ChartAnnounce text={i !== null ? tooltipText(title, tipRows) : ""} />

import { useLayoutEffect, useRef, useState } from "react";
import { type TooltipRow, tooltipLeft } from "@/lib/chart-hover";
import "./charts.css";

export type { TooltipRow };

/**
 * The hover tooltip every chart shares: the point's time (or category) as the title and one row per
 * series with its exact, formatted value. Rendered inside the plot box (`position: relative`, see
 * `.ct-box`), centred on `x` and kept inside the box's width. It is aria-hidden: screen readers get
 * the same text from <ChartAnnounce>. Format values with the lib formatters (formatCount,
 * formatLatency, formatRate, formatShare, formatBytes…), never raw numbers.
 */
export function ChartTooltip({
  x,
  boxWidth,
  title,
  rows,
  placement = "above",
}: {
  /** The anchor in px from the box's left edge (pointX(index, width, count, layout)). */
  x: number;
  /** The box's width in px (useChartHover's `width`). */
  boxWidth: number;
  title: string;
  rows: readonly TooltipRow[];
  /** Above the box (default; for small plots like sparklines) or inside it at the top. */
  placement?: "above" | "inside";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const key = `${title}|${rows.map((r) => r.value).join("|")}`;
  useLayoutEffect(() => {
    const tw = ref.current?.getBoundingClientRect().width ?? 0;
    setLeft(tooltipLeft(x, tw, boxWidth));
  }, [x, boxWidth, key]);
  return (
    <div
      ref={ref}
      className={`ct-tip ct-tip--${placement}`}
      aria-hidden="true"
      style={{ left: left ?? 0, visibility: left === null ? "hidden" : undefined }}
    >
      <p className="ct-tip__title">{title}</p>
      {rows.length > 0 ? (
        <dl className="ct-tip__rows">
          {rows.map((r) => (
            <div key={r.label || r.value} className="ct-tip__row">
              <dt>
                {r.swatch ? <span className={`ct-tip__swatch ${r.swatch}`} /> : null}
                {r.label}
              </dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * A visually hidden live region that reads the hovered point to screen readers as keyboard focus
 * moves (pass tooltipText(title, rows), or "" when nothing is shown). Keep it mounted outside the
 * conditional so the region exists before its text changes.
 */
export function ChartAnnounce({ text }: { text: string }) {
  return (
    <span className="ct-sr" aria-live="polite" aria-atomic="true">
      {text}
    </span>
  );
}

/** A vertical guide at `x` (viewBox units) from top to bottom of a plot: the line chart crosshair. */
export function Crosshair({ x, height }: { x: number; height: number }) {
  return <line className="ct-cross" x1={x} x2={x} y1={0} y2={height} />;
}
