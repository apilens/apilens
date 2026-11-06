"use client";

import { useRouter } from "next/navigation";
import { ChartAnnounce, ChartTooltip, type TooltipRow } from "@/components/charts/chart-tooltip";
import { useChartHover } from "@/components/charts/use-chart-hover";
import { pointX, tooltipText } from "@/lib/chart-hover";
import type { AppHealthStatus, AppIngestStats, IngestCounts, IngestDay, NamedApp } from "@/lib/identity";
import {
  EDGE_COUNTERS,
  dayBars,
  daysSummary,
  INGEST_DAYS,
  INGEST_RUNBOOK,
  counterShare,
  dropReasons,
  dropSummary,
  formatCount,
  ingestPath,
  plural,
  sdkLine,
  shortenedRecords,
} from "@/lib/ingest-health";
import { formatDay } from "@/lib/passkey-settings";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";
import "./ingest-health.css";

/** What the page loaded: each part is null when the API could not answer. */
export interface IngestLoad {
  apps: NamedApp[] | null;
  /** The app on screen: `?app=`, else the project's first; null without apps. */
  app: NamedApp | null;
  /** `off` when this install keeps no ingest counters (the API answers 503). */
  stats: AppIngestStats | "off" | null;
  status: AppHealthStatus | null;
}

/**
 * `/<project>/settings/ingest` (#602): per app, what the ingest edge did with its records over the
 * last 7 UTC days (accepted, rejected, truncated, masked) and what its SDKs dropped before sending,
 * by reason, over the instances seen in the last hour. Read-only for everyone who can view the
 * project; links to the runbook that says what to do when a counter moves.
 */
export function IngestHealth({ project, projectName, load }: { project: string; projectName: string; load: IngestLoad }) {
  const { apps, app } = load;
  return (
    <div className="page page--measure os cps ih">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Ingest health</h1>
        <p className="ih-lede">
          What reached APILens from each app and what was lost on the way.{" "}
          <a className="cp-link" href={INGEST_RUNBOOK} target="_blank" rel="noreferrer">
            What to do when a counter moves
          </a>
        </p>
      </header>

      {apps === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s apps. Reload the page to try again.
        </p>
      ) : app === null ? (
        <section className="os-card" aria-labelledby="ih-none">
          <div className="os-card__head">
            <h2 id="ih-none">No apps yet</h2>
            <p>Ingest counters are kept per app. An app appears here once it is registered on {projectName}.</p>
          </div>
          <div className="os-card__body" />
        </section>
      ) : (
        <>
          {apps.length > 1 ? <AppPicker project={project} apps={apps} current={app} /> : null}
          <EdgeCard app={app} stats={load.stats} />
          <SdkCard app={app} status={load.status} />
        </>
      )}
    </div>
  );
}

function AppPicker({ project, apps, current }: { project: string; apps: NamedApp[]; current: NamedApp }) {
  const router = useRouter();
  return (
    <div className="ob-f cps-app">
      <label className="ob-l" htmlFor="ih-app">
        App<small>counters are kept per app</small>
      </label>
      <div className="ob-in">
        <select id="ih-app" value={current.slug} onChange={(e) => router.push(ingestPath(project, e.target.value))}>
          {apps.map((a) => (
            <option key={a.id} value={a.slug}>
              {a.name === a.slug ? a.slug : `${a.name} (${a.slug})`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Tiles({ counts, label }: { counts: IngestCounts; label: string }) {
  return (
    <dl className="ih-tiles" aria-label={label}>
      {EDGE_COUNTERS.map((c) => {
        const sub = counterShare(c.key, counts);
        return (
          <div key={c.key}>
            <dt>{c.label}</dt>
            <dd>
              <span className="ih-tile__value">{formatCount(counts[c.key])}</span>
              <span className="ih-tile__sub">{sub ?? c.help}</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const CHART_W = 700;
const CHART_H = 120;
const dayTitle = (date: string) => formatDay(`${date}T00:00:00Z`);

/**
 * Records received per day, oldest left: accepted with rejected stacked on top. Hovering, tapping
 * or arrowing through a day shows its four counters exactly (shared chart hover); the table below
 * has the same numbers for reading and copying.
 */
function DaysChart({ days }: { days: IngestDay[] }) {
  const n = days.length;
  const hover = useChartHover<HTMLDivElement>(n, "slot");
  const i = hover.index;
  const { top, bars } = dayBars(days, CHART_W, CHART_H);
  const title = i !== null ? dayTitle(days[i].date) : "";
  const rows: TooltipRow[] =
    i !== null
      ? EDGE_COUNTERS.map((c) => ({ label: c.label, value: formatCount(days[i][c.key]), swatch: c.key === "accepted" ? "ih-fill-acc" : c.key === "rejected" ? "ih-fill-rej" : undefined }))
      : [];
  if (n === 0) return null;
  return (
    <figure className="ih-chart">
      <figcaption className="ih-chart__head">
        <span className="ih-chart__t">Records received per day</span>
        <ul className="ih-legend" aria-label="Legend">
          <li>
            <span className="ih-swatch ih-fill-acc" aria-hidden="true" />
            Accepted
          </li>
          <li>
            <span className="ih-swatch ih-fill-rej" aria-hidden="true" />
            Rejected
          </li>
        </ul>
      </figcaption>
      <div
        ref={hover.ref}
        className="ih-plot ct-box"
        role="group"
        aria-label={`Records received per day, last ${n} days (UTC). ${daysSummary(days, dayTitle)} Use the arrow keys to read each day.`}
        {...hover.bind}
      >
        <span className="ih-axis-top" aria-hidden="true">
          {formatCount(top)}
        </span>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="ih-base" x1={0} x2={CHART_W} y1={CHART_H} y2={CHART_H} />
          {i !== null ? <rect className="ct-bar-hover" x={(i * CHART_W) / n} y={0} width={CHART_W / n} height={CHART_H} /> : null}
          {bars.map((b) => (
            <g key={b.date}>
              <rect className="ih-fill-acc" x={b.x} y={b.accepted.y} width={b.w} height={b.accepted.h} />
              <rect className="ih-fill-rej" x={b.x} y={b.rejected.y} width={b.w} height={b.rejected.h} />
            </g>
          ))}
        </svg>
        {i !== null && hover.width > 0 ? <ChartTooltip x={pointX(i, hover.width, n, "slot")} boxWidth={hover.width} title={title} rows={rows} /> : null}
      </div>
      <div className="ih-axis-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {days.map((d) => (
          <span key={d.date}>{dayTitle(d.date).replace(/, \d{4}$/, "")}</span>
        ))}
      </div>
      <ChartAnnounce text={i !== null ? tooltipText(title, rows) : ""} />
    </figure>
  );
}

/** The ingest edge's counters: totals over the days, then one row per day, newest first. */
function EdgeCard({ app, stats }: { app: NamedApp; stats: AppIngestStats | "off" | null }) {
  const oldestFirst = stats && stats !== "off" ? (stats.daily ?? []) : [];
  const days = [...oldestFirst].reverse();
  return (
    <section className="os-card" aria-labelledby="ih-edge">
      <div className="os-card__head">
        <h2 id="ih-edge">At the ingest edge</h2>
        <p>
          Records <b>{app.name}</b> sent in the last {INGEST_DAYS} days (UTC), and what the edge did with them.
        </p>
      </div>
      <div className="os-card__body">
        {stats === null ? (
          <p className="pk-load-err" role="alert">
            Couldn’t load the ingest counters of {app.name}. Reload the page to try again.
          </p>
        ) : stats === "off" ? (
          <p className="cps-empty">This APILens install keeps no ingest counters: they need the Valkey store, which isn’t configured.</p>
        ) : (
          <>
            <Tiles counts={stats.totals} label={`Last ${INGEST_DAYS} days`} />
            <DaysChart days={oldestFirst} />
            <table className="pk-table ih-table" aria-label="Ingest counters per day">
              <thead>
                <tr>
                  <th scope="col">Day (UTC)</th>
                  {EDGE_COUNTERS.map((c) => (
                    <th key={c.key} scope="col">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} className="pk-row">
                    <th scope="row" data-label="Day (UTC)">
                      <time dateTime={d.date}>{formatDay(`${d.date}T00:00:00Z`)}</time>
                    </th>
                    {EDGE_COUNTERS.map((c) => (
                      <td key={c.key} data-label={c.label} className={d[c.key] > 0 && c.key === "rejected" ? "ih-hot" : undefined}>
                        {formatCount(d[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

/** The SDKs' own delivery counters: failed batches, dropped records by reason, the queue. */
function SdkCard({ app, status }: { app: NamedApp; status: AppHealthStatus | null }) {
  const stats = status?.sdk_stats ?? null;
  const summary = stats ? dropSummary(stats) : null;
  const reasons = stats ? dropReasons(stats) : [];
  const shortened = stats ? shortenedRecords(stats) : 0;
  return (
    <section className="os-card" aria-labelledby="ih-sdk">
      <div className="os-card__head">
        <h2 id="ih-sdk">In the SDKs</h2>
        <p>
          What <b>{app.name}</b>’s SDKs could not deliver, before anything reached the edge.
        </p>
      </div>
      <div className="os-card__body">
        {stats === null ? (
          <p className="pk-load-err" role="alert">
            Couldn’t load the SDK counters of {app.name}. Reload the page to try again.
          </p>
        ) : (
          <>
            {summary ? <p className="ih-drops">{summary}</p> : null}
            <p className="ih-note">{sdkLine(stats)}</p>
            {stats.instances > 0 ? (
              <dl className="ih-facts">
                <div>
                  <dt>Sent</dt>
                  <dd>{plural(stats.sent_records, "record", "records")}</dd>
                </div>
                <div>
                  <dt>Waiting in queues</dt>
                  <dd>{plural(stats.queued_records, "record", "records")}</dd>
                </div>
                <div>
                  <dt>Failed batches</dt>
                  <dd>{formatCount(stats.failed_batches)}</dd>
                </div>
                <div>
                  <dt>Dropped</dt>
                  <dd>{plural(stats.dropped_records, "record", "records")}</dd>
                </div>
              </dl>
            ) : null}
            {reasons.length ? (
              <table className="pk-table ih-table ih-reasons" aria-label="Dropped records by reason">
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
                      <td data-label="Records">{formatCount(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {shortened > 0 ? (
              <p className="ih-note">{plural(shortened, "record was", "records were")} shortened to fit a batch and still sent.</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
