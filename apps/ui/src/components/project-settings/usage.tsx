"use client";

import { ChartAnnounce, ChartTooltip, type TooltipRow } from "@/components/charts/chart-tooltip";
import { useChartHover } from "@/components/charts/use-chart-hover";
import { pointX, tooltipText } from "@/lib/chart-hover";
import { formatBytes } from "@/lib/explore";
import type { ProjectUsage, QuotaUsage, UsageDay } from "@/lib/identity";
import { formatCount, ingestPath } from "@/lib/ingest-health";
import { formatDay } from "@/lib/passkey-settings";
import { USAGE_DAYS, quotaMeter, recordsLimitLine, rejectReasons, usageBars, usageSummary } from "@/lib/project-usage";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";
import "./ingest-health.css";
import "./usage.css";

/** What the page loaded: `off` when the install keeps no ingest counters (503), null when the API could not answer. */
export type UsageLoad = ProjectUsage | "off" | null;

/**
 * `/<project>/settings/usage` (#819): the records the project sent over the last 30 UTC days, per
 * day, per app and per environment, what the edge rejected and why, and today's use of the ingest
 * quota. Read-only for everyone who can view the project; the same counters as Ingest health,
 * summed over the project's apps.
 */
export function UsageSection({ project, projectName, usage }: { project: string; projectName: string; usage: UsageLoad }) {
  return (
    <div className="page page--measure os cps ih us">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Usage</h1>
        <p className="ih-lede">Records {projectName} sent in the last {USAGE_DAYS} days (UTC), and how close today is to the ingest quota.</p>
      </header>

      {usage === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s usage. Reload the page to try again.
        </p>
      ) : usage === "off" ? (
        <section className="os-card" aria-labelledby="us-off">
          <div className="os-card__head">
            <h2 id="us-off">No usage counters</h2>
            <p>This APILens install keeps no ingest counters: they need the Valkey store, which isn’t configured.</p>
          </div>
          <div className="os-card__body" />
        </section>
      ) : (
        <Populated project={project} usage={usage} />
      )}
    </div>
  );
}

function Populated({ project, usage }: { project: string; usage: ProjectUsage }) {
  const days = usage.daily ?? [];
  const received = usage.totals.accepted + usage.totals.rejected;
  const apps = usage.apps ?? [];
  const envs = usage.environments ?? [];
  const reasons = rejectReasons(usage.totals.rejected_by_reason);
  return (
    <>
      <section className="os-card" aria-labelledby="us-records">
        <div className="os-card__head">
          <h2 id="us-records">Accepted records</h2>
          <p>
            <b>{formatCount(usage.totals.accepted)}</b> records stored and <b>{formatBytes(usage.bytes)}</b> received in the last {usage.days} days.
          </p>
        </div>
        <div className="os-card__body">
          {received === 0 ? (
            <p className="cps-empty">Nothing reached the ingest edge in the last {usage.days} days. Records appear here once an SDK sends data to this project.</p>
          ) : (
            <DaysChart days={days} />
          )}
        </div>
      </section>

      {received > 0 ? (
        <div className="us-split">
          <section className="os-card" aria-labelledby="us-apps">
            <div className="os-card__head">
              <h2 id="us-apps">By app</h2>
            </div>
            <div className="os-card__body">
              {apps.length === 0 ? (
                <p className="cps-empty">No apps on this project yet.</p>
              ) : (
                <table className="pk-table ih-table" aria-labelledby="us-apps">
                  <thead>
                    <tr>
                      <th scope="col">App</th>
                      <th scope="col">Accepted</th>
                      <th scope="col">Rejected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apps.map((a) => (
                      <tr key={a.app_id} className="pk-row">
                        <th scope="row" data-label="App">
                          {a.app}
                        </th>
                        <td data-label="Accepted">{formatCount(a.accepted)}</td>
                        <td data-label="Rejected" className={a.rejected > 0 ? "ih-hot" : undefined}>
                          {formatCount(a.rejected)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <section className="os-card" aria-labelledby="us-envs">
            <div className="os-card__head">
              <h2 id="us-envs">By environment</h2>
            </div>
            <div className="os-card__body">
              {envs.length === 0 ? (
                <p className="cps-empty">No records carried an environment.</p>
              ) : (
                <table className="pk-table ih-table" aria-labelledby="us-envs">
                  <thead>
                    <tr>
                      <th scope="col">Environment</th>
                      <th scope="col">Accepted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {envs.map((e) => (
                      <tr key={e.environment} className="pk-row">
                        <th scope="row" data-label="Environment">
                          {e.environment}
                        </th>
                        <td data-label="Accepted">{formatCount(e.accepted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <section className="os-card" aria-labelledby="us-rejected">
        <div className="os-card__head">
          <h2 id="us-rejected">Rejected records</h2>
          <p>
            What the ingest edge refused in the last {usage.days} days.{" "}
            <a className="cp-link" href={ingestPath(project)}>
              Open Ingest health
            </a>
          </p>
        </div>
        <div className="os-card__body">
          {reasons.length === 0 ? (
            <p className="cps-empty">Nothing rejected.</p>
          ) : (
            <table className="pk-table ih-table ih-reasons" aria-label="Rejected records by reason">
              <thead>
                <tr>
                  <th scope="col">Reason</th>
                  <th scope="col">Records</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map((r) => (
                  <tr key={r.reason} className="pk-row">
                    <th scope="row" data-label="Reason">
                      {r.label}
                      {r.label !== r.reason ? <code>{r.reason}</code> : null}
                    </th>
                    <td data-label="Records">{formatCount(r.records)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <QuotaCard quota={usage.quota} />
    </>
  );
}

const CHART_W = 700;
const CHART_H = 120;
const dayTitle = (date: string) => formatDay(`${date}T00:00:00Z`);

/**
 * Accepted records per day, oldest left. Hovering, tapping or arrowing through a day shows its
 * accepted, rejected and bytes (shared chart hover); the group's label summarises the month.
 */
function DaysChart({ days }: { days: UsageDay[] }) {
  const n = days.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const { top, bars } = usageBars(days, CHART_W, CHART_H);
  const title = i !== null ? dayTitle(days[i].date) : "";
  const rows: TooltipRow[] =
    i !== null
      ? [
          { label: "Accepted", value: formatCount(days[i].accepted), swatch: "ih-fill-acc" },
          { label: "Rejected", value: formatCount(days[i].rejected) },
          { label: "Bytes", value: formatBytes(days[i].bytes) },
        ]
      : [];
  if (n === 0) return null;
  const first = dayTitle(days[0].date).replace(/, \d{4}$/, "");
  const last = dayTitle(days[n - 1].date).replace(/, \d{4}$/, "");
  return (
    <figure className="ih-chart us-chart">
      <figcaption className="ih-chart__head">
        <span className="ih-chart__t">Records accepted per day</span>
      </figcaption>
      <div
        ref={hover.ref}
        className="ih-plot ct-box"
        role="group"
        aria-label={`Records accepted per day, last ${n} days (UTC). ${usageSummary(days, dayTitle)} Use the arrow keys to read each day.`}
        {...hover.bind}
      >
        <span className="ih-axis-top" aria-hidden="true">
          {formatCount(top)}
        </span>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="ih-base" x1={0} x2={CHART_W} y1={CHART_H} y2={CHART_H} />
          {i !== null ? <rect className="ct-bar-hover" x={(i * CHART_W) / n} y={0} width={CHART_W / n} height={CHART_H} /> : null}
          {bars.map((b) => (
            <rect key={b.date} className="ih-fill-acc" x={b.x} y={b.y} width={b.w} height={b.h} />
          ))}
        </svg>
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={rows} /> : null}
      </div>
      <div className="us-axis-x" aria-hidden="true">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, rows) : ""} />
    </figure>
  );
}

/** The configured ingest limits; a meter of today's bytes when a bytes-per-day quota is set. */
function QuotaCard({ quota }: { quota: QuotaUsage }) {
  const meter = quotaMeter(quota);
  return (
    <section className="os-card" aria-labelledby="us-quota">
      <div className="os-card__head">
        <h2 id="us-quota">Quota</h2>
        <p>The ingest limits of this install. Records over a limit are rejected at the edge.</p>
      </div>
      <div className="os-card__body">
        {meter ? (
          <div className="us-meter">
            <div className="us-meter__head">
              <span id="us-meter-l">Bytes today</span>
              <span className="us-meter__v">{meter.label}</span>
            </div>
            <div
              className={`us-meter__track us-meter--${meter.tone}`}
              role="meter"
              aria-labelledby="us-meter-l"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={meter.percent}
              aria-valuetext={meter.label}
            >
              <span className="us-meter__fill" style={{ width: `${meter.percent}%` }} />
            </div>
          </div>
        ) : null}
        <dl className="ih-facts us-facts">
          <div>
            <dt>Records per minute</dt>
            <dd>{recordsLimitLine(quota)}</dd>
          </div>
          <div>
            <dt>Bytes per day</dt>
            <dd>{quota.bytes_per_day > 0 ? formatBytes(quota.bytes_per_day) : "Unlimited"}</dd>
          </div>
          <div>
            <dt>Rejected today by a quota</dt>
            <dd className={quota.rejected_today > 0 ? "ih-hot" : undefined}>{formatCount(quota.rejected_today)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
