import {
  APPS_LOAD_FAILED,
  HEALTH_LABEL,
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
import { formatPerMinute, formatRate } from "@/lib/consumers";
import type { AppStatus, NamedApp, TrafficPoint, TrafficSummary } from "@/lib/identity";
import { dropSummary } from "@/lib/ingest-health";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { Sparkline } from "../traffic/charts";
import "./apps.css";

/** One app with its reads; each is null when the API could not answer it. */
export interface AppCardData {
  app: NamedApp;
  status: AppStatus | null;
  summary: TrafficSummary | null;
  points: TrafficPoint[] | null;
}

/**
 * `/<project>/apps` (#591). One card per app of the project: requests per minute, error rate and
 * p95 over the last 24 hours with a requests sparkline, the app's health from its 5xx share,
 * whether its SDKs are reporting (heartbeats) and the SDK version against the latest release.
 * Each card opens the app. `apps` is null when the project's apps could not be read.
 */
export function AppsView({ project, projectName, apps, now }: { project: string; projectName: string; apps: AppCardData[] | null; now: number }) {
  const attention = (apps ?? []).filter((a) => a.status !== null && needsAttention(a.status)).length;
  return (
    <div className="ap">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Apps</p>
        <h1 className="cp-lede">Apps</h1>
        <p className="ap-lead">
          The services reporting to this project: traffic over the last 24 hours, health and SDK status.
          {attention > 0 ? ` ${attention} ${attention === 1 ? "app needs" : "apps need"} attention.` : ""}
        </p>
      </header>

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
      ) : apps.length === 0 ? (
        <div className="ap-notice" role="status">
          <ObIcon name="info" />
          <p>No apps in this project yet. An app shows up here once its SDK is set up with one of this project’s API keys.</p>
        </div>
      ) : (
        <ul className="ap-grid" aria-label="Apps">
          {apps.map((a) => (
            <AppCard key={a.app.id} project={project} data={a} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AppCard({ project, data: { app, status, summary, points }, now }: { project: string; data: AppCardData; now: number }) {
  const health = summary ? appHealth(summary) : null;
  const sdks = status?.sdks ?? [];
  return (
    <li className="ap-card" aria-labelledby={`ap-${app.id}`}>
      <div className="ap-card__head">
        <h2 id={`ap-${app.id}`}>
          <a className="ap-card__link" href={appHref(project, app.slug)}>
            {app.name}
          </a>
        </h2>
        {status ? (
          <span className={`ap-pill ap-pill--${reportingTone(status.status)}`} title={REPORTING_HINT[status.status]}>
            <span className="ap-dot" aria-hidden="true" />
            {REPORTING_LABEL[status.status]}
          </span>
        ) : null}
      </div>
      {app.slug !== app.name ? <code className="ap-slug">{app.slug}</code> : null}

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
          <Sparkline values={(points ?? []).map((p) => p.requests)} />
          {health ? (
            <p className={`ap-health ap-health--${health}`}>
              <span className="ap-dot" aria-hidden="true" />
              {HEALTH_LABEL[health]}
            </p>
          ) : null}
        </>
      )}

      <div className="ap-card__foot">
        {status === null ? (
          <p className="ap-muted">{STATUS_LOAD_FAILED}</p>
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
