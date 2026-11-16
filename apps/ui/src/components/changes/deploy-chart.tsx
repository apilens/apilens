"use client";

import { ChartAnnounce, ChartTooltip, Crosshair, type TooltipRow } from "@/components/charts/chart-tooltip";
import { useChartHover } from "@/components/charts/use-chart-hover";
import { formatMinute, formatRate, minuteOffsetText, p95LinePath, p95Scale } from "@/lib/changes";
import { pointX, tooltipText } from "@/lib/chart-hover";
import { niceMax } from "@/lib/consumers";
import { formatCount } from "@/lib/first-data";
import type { DeployPoint } from "@/lib/identity";
import { formatLatency } from "@/lib/traffic";

const W = 1000;
const BARS_H = 120;
const LINE_H = 64;

/**
 * Requests per minute (2xx/3xx, 4xx and 5xx stacked) and p95 latency per minute across the hour
 * before and the hour after a deploy, one shared hover over both plots (mouse, touch, or focus and
 * the arrow keys), with a marker on the deploy's minute. Every number in the tooltip is exact.
 */
export function DeployChart({ series, deployMinute, release }: { series: readonly DeployPoint[]; deployMinute: string; release: string }) {
  const n = series.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const deployAt = series.findIndex((p) => p.ts === deployMinute || Date.parse(p.ts) === Date.parse(deployMinute));
  const maxReq = niceMax(Math.max(0, ...series.map((p) => p.requests)));
  const scale = p95Scale(series);
  const maxP95 = niceMax(scale.max);
  const slot = W / Math.max(1, n);
  const gap = slot > 4 ? 1 : 0;
  const markX = deployAt >= 0 ? (deployAt + 0.5) * slot : null;
  const markPct = deployAt >= 0 ? ((deployAt + 0.5) / n) * 100 : null;
  const line = p95LinePath(
    series.map((p) => p.p95_ms),
    series.map((p) => p.requests > 0),
    W,
    LINE_H,
    maxP95,
  );

  const pt = i !== null ? series[i] : null;
  const title = pt ? `${formatMinute(pt.ts)} · ${minuteOffsetText(pt.ts, deployMinute)}` : "";
  const rows: TooltipRow[] = pt
    ? [
        { label: "Requests", value: formatCount(pt.requests) },
        { label: "4xx", value: `${formatCount(pt.client_errors)}${pt.requests > 0 ? ` (${formatRate(pt.client_errors / pt.requests)})` : ""}`, swatch: "chd-fill-4xx" },
        { label: "5xx", value: `${formatCount(pt.server_errors)}${pt.requests > 0 ? ` (${formatRate(pt.server_errors / pt.requests)})` : ""}`, swatch: "chd-fill-5xx" },
        { label: "p95", value: pt.requests > 0 ? formatLatency(pt.p95_ms) : "–", swatch: "chd-fill-line" },
      ]
    : [];
  const first = series[0];
  const last = series[n - 1];

  return (
    <figure className="chd-chart">
      <div
        ref={hover.ref}
        className="ct-box chd-plots"
        role="group"
        aria-label={`Requests, errors and p95 latency per minute from ${formatMinute(first.ts)} to ${formatMinute(last.ts)}, with ${release} deployed at ${formatMinute(deployMinute)}. Use the arrow keys to read each minute.`}
        {...hover.bind}
      >
        <div className="chd-plot">
          <span className="chd-axis-max" aria-hidden="true">
            {formatCount(maxReq)} req/min
          </span>
          <svg viewBox={`0 0 ${W} ${BARS_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ height: BARS_H }}>
            <line className="chd-grid" x1={0} x2={W} y1={BARS_H / 2} y2={BARS_H / 2} />
            {series.map((p, k) => {
              if (p.requests <= 0) return null;
              const x = k * slot + gap / 2;
              const w = Math.max(0.5, slot - gap);
              const ok = Math.max(0, p.requests - p.client_errors - p.server_errors);
              const hOk = (ok / maxReq) * BARS_H;
              const h4 = (p.client_errors / maxReq) * BARS_H;
              const h5 = (p.server_errors / maxReq) * BARS_H;
              return (
                <g key={p.ts}>
                  <rect className="chd-fill-ok" x={x} width={w} y={BARS_H - hOk} height={hOk} />
                  <rect className="chd-fill-4xx" x={x} width={w} y={BARS_H - hOk - h4} height={h4} />
                  <rect className="chd-fill-5xx" x={x} width={w} y={BARS_H - hOk - h4 - h5} height={h5} />
                </g>
              );
            })}
            {i !== null ? <rect className="ct-bar-hover" x={i * slot} width={slot} y={0} height={BARS_H} /> : null}
            {markX !== null ? <line className="chd-mark" x1={markX} x2={markX} y1={0} y2={BARS_H} /> : null}
            <line className="chd-base" x1={0} x2={W} y1={BARS_H - 0.5} y2={BARS_H - 0.5} />
          </svg>
        </div>
        <div className="chd-plot">
          <span className="chd-axis-max" aria-hidden="true">
            p95 {formatLatency(maxP95)}
            {scale.offScale > 0 ? ` · ${scale.offScale} near-idle ${scale.offScale === 1 ? "minute" : "minutes"} above, clipped` : ""}
          </span>
          <svg viewBox={`0 0 ${W} ${LINE_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ height: LINE_H }}>
            <line className="chd-grid" x1={0} x2={W} y1={LINE_H / 2} y2={LINE_H / 2} />
            {markX !== null ? <line className="chd-mark" x1={markX} x2={markX} y1={0} y2={LINE_H} /> : null}
            {line ? <path className="chd-line" d={line} /> : null}
            {i !== null ? <Crosshair x={pointX(i, W, n, "slot")} height={LINE_H} /> : null}
            <line className="chd-base" x1={0} x2={W} y1={LINE_H - 0.5} y2={LINE_H - 0.5} />
          </svg>
          {pt && pt.requests > 0 && hover.width > 0 ? (
            <span className="ct-dot-html" style={{ left: pointX(i as number, hover.width, n, "slot"), top: LINE_H - 1 - (Math.min(pt.p95_ms, maxP95) / maxP95) * (LINE_H - 2) }} />
          ) : null}
        </div>
        {markPct !== null ? (
          <span className="chd-mark-label" style={{ left: `${markPct}%` }} aria-hidden="true">
            Deploy
          </span>
        ) : null}
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={rows} placement="inside" /> : null}
      </div>
      <div className="chd-xaxis" aria-hidden="true">
        <span>{formatMinute(first.ts)}</span>
        {markPct !== null && markPct > 15 && markPct < 85 ? (
          <span className="chd-xaxis__mark" style={{ left: `${markPct}%` }}>
            {formatMinute(deployMinute)}
          </span>
        ) : null}
        <span>{formatMinute(last.ts)}</span>
      </div>
      <figcaption className="chd-legend">
        <span>
          <i className="chd-sw chd-fill-ok" /> 2xx/3xx
        </span>
        <span>
          <i className="chd-sw chd-fill-4xx" /> 4xx
        </span>
        <span>
          <i className="chd-sw chd-fill-5xx" /> 5xx
        </span>
        <span>
          <i className="chd-sw chd-sw--line chd-fill-line" /> p95 latency
        </span>
        <span>
          <i className="chd-sw chd-sw--mark" /> Deploy minute (in neither side)
        </span>
      </figcaption>
      <ChartAnnounce text={pt ? tooltipText(title, rows) : ""} />
    </figure>
  );
}
