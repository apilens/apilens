"use client";

import { HEALTH_LABEL, type AppHealth } from "@/lib/apps";
import { tooltipText } from "@/lib/chart-hover";
import { formatRate } from "@/lib/consumers";
import { formatCount } from "@/lib/first-data";
import type { TrafficSummary } from "@/lib/identity";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";

/**
 * An app card's health line ("Healthy", "Degraded", "Failing", "No traffic"), hoverable and
 * focusable like a chart point: the shared tooltip shows the exact counts behind it (requests,
 * 4xx, 5xx and the 5xx share the health is judged on) over the cards' range.
 */
export function AppHealthLine({ health, summary, range }: { health: AppHealth; summary: Pick<TrafficSummary, "requests" | "client_errors" | "server_errors">; range: string }) {
  const hover = useChartHover<HTMLSpanElement>(1, "slot");
  const shown = hover.index !== null;
  const title = `Last ${range}`;
  const rows = [
    { label: "Requests", value: formatCount(summary.requests) },
    { label: "4xx", value: formatCount(summary.client_errors) },
    { label: "5xx", value: formatCount(summary.server_errors) },
    { label: "5xx share", value: formatRate(summary.server_errors, summary.requests) },
  ];
  return (
    <>
      <span
        ref={hover.ref}
        className={`ap-health ap-health--${health} ct-box`}
        role="group"
        aria-label={`${HEALTH_LABEL[health]}: ${formatCount(summary.server_errors)} server errors in ${formatCount(summary.requests)} requests. Focus to read the counts.`}
        {...hover.bind}
      >
        <span className="ap-dot" aria-hidden="true" />
        {HEALTH_LABEL[health]}
        {shown && hover.width > 0 ? <ChartTooltip x={0} boxWidth={hover.width} title={title} rows={rows} /> : null}
      </span>
      <ChartAnnounce text={shown ? tooltipText(`${HEALTH_LABEL[health]}, last ${range}`, rows) : ""} />
    </>
  );
}
