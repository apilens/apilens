import { keysPath } from "@/lib/api-keys";
import { APPS_PAGE, inactiveApps, lastDataText, newApps, originText, rejectionFixes, rejectionHeadline, rejectionLine, rejectionRows } from "@/lib/app-manage";
import {
  APPS_LOAD_FAILED,
  APPS_RANGE,
  REPORTING_HINT,
  REPORTING_LABEL,
  STATUS_LOAD_FAILED,
  TRAFFIC_LOAD_FAILED,
  appHealth,
  appHref,
  appsHref,
  formatLastSeen,
  needsAttention,
  reportingTone,
  sdkUpdate,
  sdkVersions,
} from "@/lib/apps";
import { RANGE_LABEL, formatCount, formatPerMinute, formatRate } from "@/lib/consumers";
import type { AppRejections, AppStatus, ManagedApp, NamedApp, TrafficPoint, TrafficSummary } from "@/lib/identity";
import { dropSummary } from "@/lib/ingest-health";
import type { SearchParams } from "@/lib/pagination";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { Pagination } from "../pagination/pagination";
import { Sparkline } from "../traffic/charts";
import { AppHealthLine } from "./app-health";
import { AppActionsMenu, AppManager, AppsReadOnly, ArchivedApps, NewAppsNotice } from "./app-manage";
import "./apps.css";

/** One app with its reads; each is null when the API could not answer it. */
export interface AppCardData {
  app: NamedApp;
  /** Its origin and lifecycle from `GET /projects/{slug}/apps`; null when that list could not be read. */
  managed: ManagedApp | null;
  status: AppStatus | null;
  summary: TrafficSummary | null;
  points: TrafficPoint[] | null;
}

export interface AppsViewProps {
  project: string;
  projectName: string;
  /** The cards of the page shown; null when the project's apps could not be read. */
  apps: AppCardData[] | null;
  /** Every active app (all pages). */
  total: number;
  /** The project's apps in every state, or null when that list could not be read. */
  managed: ManagedApp[] | null;
  /** Records the ingest edge rejected for app names, or null when they could not be read. */
  rejections: AppRejections | null;
  params: SearchParams;
  now: number;
}

/**
 * `/<project>/apps` (#591). One card per active app of the project, paged in the URL: requests per
 * minute, error rate and p95 over the last 24 hours with a requests sparkline and a health line
 * (both hoverable for the exact numbers), whether its SDKs are reporting and their version, where
 * the app came from (apps come from the SDK: an unknown app name creates the app) and an actions
 * menu (rename, merge, archive) for readers with `capture.manage`. Above the cards: new apps an SDK
 * created, to keep or merge, and records rejected for app names with what to do. Below: archived,
 * merged and deleted apps, collapsed, with restore and delete.
 */
export function AppsView({ project, projectName, apps, total, managed, rejections, params, now }: AppsViewProps) {
  const attention = (apps ?? []).filter((a) => a.status !== null && needsAttention(a.status)).length;
  const fresh = newApps(managed ?? []);
  const archived = inactiveApps(managed ?? []);
  return (
    <div className="page ap">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Apps</p>
        <h1 className="cp-lede">Apps</h1>
        <p className="ap-lead">
          The services reporting to this project: traffic over the last 24 hours, health and SDK status. An app appears on its own the first time an SDK sends data with
          its name.
          {attention > 0 ? ` ${attention} ${attention === 1 ? "app needs" : "apps need"} attention.` : ""}
        </p>
      </header>

      <AppManager project={project} apps={managed ?? []}>
        {managed && managed.length > 0 ? <AppsReadOnly /> : null}
        {rejections ? <RejectionsNotice project={project} rejections={rejections} now={now} /> : null}
        <NewAppsNotice apps={fresh} now={now} />

        {apps === null ? (
          <div className="ap-notice ap-notice--error" role="alert">
            <ObIcon name="info" />
            <p>
              {APPS_LOAD_FAILED}{" "}
              <a className="cp-link" href={appsHref(project)}>
                Try again
              </a>
            </p>
          </div>
        ) : total === 0 ? (
          <div className="ap-notice ap-empty" role="status">
            <ObIcon name="info" />
            <div>
              <p>
                <b>No apps yet.</b> An app appears here when an SDK sends its first request with an app name (<code>app_id</code> in the SDK config, or{" "}
                <code>APILENS_APP_ID</code>). Data without a name goes to the project’s default app.
              </p>
              <p>
                <a className="cp-link" href={keysPath(project)}>
                  Get an ingest key
                </a>
              </p>
            </div>
          </div>
        ) : (
          <>
            <ul className="ap-grid" aria-label="Apps">
              {apps.map((a) => (
                <AppCard key={a.app.id} project={project} data={a} now={now} />
              ))}
            </ul>
            <Pagination pathname={appsHref(project)} params={params} total={total} {...APPS_PAGE} label="App pages" />
          </>
        )}

        <ArchivedApps apps={archived} now={now} />
      </AppManager>
    </div>
  );
}

function AppCard({ project, data: { app, managed, status, summary, points }, now }: { project: string; data: AppCardData; now: number }) {
  const health = summary ? appHealth(summary) : null;
  const sdks = status?.sdks ?? [];
  const series = points ?? [];
  return (
    <li className="ap-card" aria-labelledby={`ap-${app.id}`}>
      <div className="ap-card__head">
        <h2 id={`ap-${app.id}`}>
          <a className="ap-card__link" href={appHref(project, app.slug)}>
            {app.name}
          </a>
        </h2>
        <div className="ap-card__tools">
          {status ? (
            <span className={`ap-pill ap-pill--${reportingTone(status.status)}`} title={REPORTING_HINT[status.status]}>
              <span className="ap-dot" aria-hidden="true" />
              {REPORTING_LABEL[status.status]}
            </span>
          ) : null}
          {managed ? <AppActionsMenu app={managed} /> : null}
        </div>
      </div>
      {app.slug !== app.name ? <code className="ap-slug">{app.slug}</code> : null}
      {managed ? (
        <p className="ap-origin">
          {managed.is_default ? (
            <span className="ap-tag" title="Receives data that names no app.">
              Default app
            </span>
          ) : null}
          {managed.new ? <span className="ap-tag ap-tag--new">New</span> : null}
          <span>{originText(managed, now)}</span>
        </p>
      ) : null}

      {summary === null ? (
        <p className="ap-muted ap-card__traffic">{TRAFFIC_LOAD_FAILED}</p>
      ) : (
        <>
          <dl className="ap-metrics">
            <div>
              <dt>Requests/min</dt>
              <dd>{formatPerMinute(summary.requests_per_minute)}</dd>
            </div>
            <div>
              <dt>Error rate</dt>
              <dd>{formatRate(summary.client_errors + summary.server_errors, summary.requests)}</dd>
            </div>
            <div>
              <dt>p95</dt>
              <dd>{summary.requests > 0 ? formatLatency(summary.p95_ms) : "n/a"}</dd>
            </div>
          </dl>
          <Sparkline
            values={series.map((p) => p.requests)}
            hover={{ label: "Requests", range: APPS_RANGE, points: series.map((p) => ({ ts: p.ts, text: formatCount(p.requests) })) }}
          />
          {health ? <AppHealthLine health={health} summary={summary} range={RANGE_LABEL[APPS_RANGE]} /> : null}
        </>
      )}

      <div className="ap-card__foot">
        {status === null ? (
          <>
            <p className="ap-muted">{STATUS_LOAD_FAILED}</p>
            {managed ? <p className="ap-muted">{lastDataText(managed.last_seen_at, now)}</p> : null}
          </>
        ) : (
          <>
            {sdks.length === 0 ? <p className="ap-muted">No SDK reported yet</p> : null}
            {sdks.map((s) => {
              const update = sdkUpdate(s);
              return (
                <p key={s.name} className="ap-sdk">
                  <code>{sdkVersions(s)}</code>
                  {update ? <span className="ap-update">{update}</span> : null}
                </p>
              );
            })}
            {status.sdk_stats && dropSummary(status.sdk_stats) ? <p className="ap-drops">{dropSummary(status.sdk_stats)}</p> : null}
            <p className="ap-muted">{formatLastSeen(status.last_seen_at, now)}</p>
          </>
        )}
      </div>
    </li>
  );
}

/** Records the ingest edge rejected for app names in the last days, per app and reason, with what to do. */
function RejectionsNotice({ project, rejections, now }: { project: string; rejections: AppRejections; now: number }) {
  const rows = rejectionRows(rejections.rejections);
  if (!rejections.available || rows.length === 0) return null;
  const fixes = rejectionFixes(rows);
  return (
    <section className="ap-notice ap-notice--warn" aria-labelledby="ap-rej-title">
      <ObIcon name="info" />
      <div className="ap-notice__body">
        <h2 id="ap-rej-title">Some data was rejected</h2>
        <p>{rejectionHeadline(rows, rejections.days)} The SDKs named apps this project couldn’t accept:</p>
        <ul className="ap-rejlist">
          {rows.map((r) => (
            <li key={`${r.app} ${r.reason}`}>{rejectionLine(r, now)}</li>
          ))}
        </ul>
        <p className="ap-fix-h">What to do</p>
        <ul className="ap-rejlist">
          {fixes.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p>
          <a className="cp-link" href={keysPath(project)}>
            Open API keys
          </a>
        </p>
      </div>
    </section>
  );
}
