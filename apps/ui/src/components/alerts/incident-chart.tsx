"use client";

// One alert rule's incidents as bars (#610): the value that triggered each incident on the page,
// oldest to newest, against the rule's threshold, with the shared chart hover (components/charts):
// hovering, tapping or arrowing through a bar shows when it started, its value, the threshold and
// how long it lasted.
import { pointX, tooltipText } from "@/lib/chart-hover";
import { conditionText, eventDuration, formatMetric } from "@/lib/alerts";
import { niceMax } from "@/lib/consumers";
import type { AlertEvent, AlertRule } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { ChartAnnounce, ChartTooltip } from "../charts/chart-tooltip";
import { useChartHover } from "../charts/use-chart-hover";

const W = 600;
const H = 120;

/**
 * `events` newest first, as the API answers; drawn oldest first. Open incidents are --error, resolved
 * ones neutral; the legend names both and the dashed line is the threshold, so nothing is told by
 * color alone. `now` is the load time (the duration of an open incident).
 */
export function IncidentChart({ rule, events, now }: { rule: Pick<AlertRule, "metric" | "condition" | "threshold">; events: readonly AlertEvent[]; now: number }) {
  const rows = [...events].reverse();
  const n = rows.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const values = rows.map((e) => (Number.isFinite(e.value) ? Math.max(0, e.value) : 0));
  const top = niceMax(Math.max(rule.threshold, ...values) * 1.1);
  const y = (v: number) => H - (Math.max(0, v) / top) * H;
  const slot = n ? W / n : W;
  const gap = slot > 6 ? Math.min(8, slot * 0.25) : 0;
  const e = i !== null ? rows[i] : null;
  const title = e ? `Started ${formatExact(e.started_at)}` : "";
  const tipRows = e
    ? [
        { label: "Value", value: formatMetric(rule.metric, e.value), swatch: e.ended_at ? "al-c-resolved" : "al-c-open" },
        { label: "Threshold", value: conditionText(rule.metric, rule.condition, rule.threshold) },
        { label: e.ended_at ? "Resolved after" : "Ongoing for", value: eventDuration(e, now) },
      ]
    : [];
  const summary = `${n} incidents, from ${formatExact(rows[0]?.started_at ?? "")} to ${formatExact(rows[n - 1]?.started_at ?? "")}, threshold ${conditionText(rule.metric, rule.condition, rule.threshold)}.`;
  return (
    <figure className="al-chart">
      <ul className="al-legend" aria-label="Incident values legend">
        <li>
          <span className="al-swatch al-c-open" aria-hidden="true" />
          Open
        </li>
        <li>
          <span className="al-swatch al-c-resolved" aria-hidden="true" />
          Resolved
        </li>
        <li>
          <span className="al-swatch-threshold" aria-hidden="true" />
          Threshold {conditionText(rule.metric, rule.condition, rule.threshold)}
        </li>
      </ul>
      <div className="ct-box al-chart__box" ref={hover.ref} role="group" aria-label={`Value of each incident. ${summary} Use the arrow keys to read each incident.`} {...hover.bind}>
        <span className="al-chart__top" aria-hidden="true">
          {formatMetric(rule.metric, top)}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="al-base" x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} />
          {i !== null ? <rect className="ct-bar-hover" x={i * slot} y={0} width={slot} height={H} /> : null}
          {rows.map((ev, k) => {
            const v = values[k];
            const h = Math.max(1, H - y(v));
            return <rect key={ev.id} className={ev.ended_at ? "al-c-resolved" : "al-c-open"} x={k * slot + gap / 2} y={H - h} width={Math.max(1, slot - gap)} height={h} rx={slot - gap >= 6 ? 2 : 0} />;
          })}
          <line className="al-threshold" x1={0} x2={W} y1={y(rule.threshold)} y2={y(rule.threshold)} />
        </svg>
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={tipRows} placement="inside" /> : null}
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, tipRows) : ""} />
      <figcaption className="al-axis" aria-hidden="true">
        <span>{rows[0] ? formatExact(rows[0].started_at) : ""}</span>
        <span>{rows[n - 1] ? formatExact(rows[n - 1].started_at) : ""}</span>
      </figcaption>
    </figure>
  );
}
