"use client";

import { useRouter } from "next/navigation";
import type { AppHealthStatus, AppIngestStats, IngestCounts, NamedApp } from "@/lib/identity";
import {
  EDGE_COUNTERS,
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
    <div className="os cps ih">
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

/** The ingest edge's counters: totals over the days, then one row per day, newest first. */
function EdgeCard({ app, stats }: { app: NamedApp; stats: AppIngestStats | "off" | null }) {
  const days = stats && stats !== "off" ? [...(stats.daily ?? [])].reverse() : [];
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
