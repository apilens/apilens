import { deployHref, formatDeployTime, shortCommit } from "@/lib/changes";
import {
  APPS_LOAD_FAILED,
  APPS_RANGE,
  APP_DEPLOYS_RANGE,
  APP_INSTANCES_SHOWN,
  DEPLOYS_LOAD_FAILED,
  ENDPOINTS_LOAD_FAILED,
  HEALTH_LABEL,
  REPORTING_HINT,
  REPORTING_LABEL,
  STATUS_LOAD_FAILED,
  TRAFFIC_LOAD_FAILED,
  appHealth,
  appHref,
  appIsEmpty,
  appsHref,
  formatLastSeen,
  instanceRelease,
  instanceSdk,
  reportingTone,
  sdkUpdate,
  sdkVersions,
} from "@/lib/apps";
import { RANGE_LABEL, formatCount } from "@/lib/consumers";
import { endpointPageHref } from "@/lib/endpoint-detail";
import { formatPercent, ratio } from "@/lib/format";
import type { AppStatus, DeployChange, EndpointTraffic, NamedApp, TrafficSummary } from "@/lib/identity";
import { projectSectionHref } from "@/lib/project-settings";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import "../traffic/traffic.css";
import "./apps.css";

export interface AppDetailProps {
  project: string;
  projectName: string;
  /** The app's slug from the URL. */
  slug: string;
  /** The app; null when the project's apps could not be read. */
  app: NamedApp | null;
  /** Each read is null when the API could not answer it. */
  status: AppStatus | null;
  summary: TrafficSummary | null;
  endpoints: EndpointTraffic[] | null;
  deploys: DeployChange[] | null;
  now: number;
  /** The user's time zone. */
  tz: string;
}

/**
 * `/project/<project>/apps/<app>` (#995): one app's overview over the last 24 hours. The header names the
 * app with its SDKs, environments, reporting state and health; tiles give requests, 5xx rate and
 * p95; the busiest endpoints each open the endpoint's page scoped to this app; then the SDK
 * instances and the deploys of the last 7 days. An app that has sent nothing yet shows how to set
 * up the SDK instead.
 */
export function AppDetailView({ project, projectName, slug, app, status, summary, endpoints, deploys, now, tz }: AppDetailProps) {
  const title = app?.name ?? slug;
  const range = RANGE_LABEL[APPS_RANGE];
  return (
    <div className="page ap ap-detail">
      <header className="pagehead">
        <p className="cp-h">
          {projectName} ·{" "}
          <a className="cp-link" href={appsHref(project)}>
            Apps
          </a>
        </p>
        <h1 className="cp-lede">{title}</h1>
        {app && app.slug !== app.name ? <code className="ap-slug">{app.slug}</code> : null}
        {app ? <AppFacts status={status} summary={summary} now={now} /> : null}
      </header>

      {app === null ? (
        <Failed text={APPS_LOAD_FAILED} href={appHref(project, slug)} />
      ) : appIsEmpty(summary, status) ? (
        <SetupState project={project} app={app} />
      ) : (
        <>
          <section aria-labelledby="ap-d-traffic">
            <h2 id="ap-d-traffic" className="ap-d-h">
              Last {range}
            </h2>
            {summary === null ? <Failed text={TRAFFIC_LOAD_FAILED} href={appHref(project, slug)} /> : <Tiles summary={summary} />}
          </section>

          <section className="tr-card tr-card--table" aria-labelledby="ap-d-endpoints">
            <h2 id="ap-d-endpoints">Top endpoints</h2>
            {endpoints === null ? (
              <Failed text={ENDPOINTS_LOAD_FAILED} href={appHref(project, slug)} />
            ) : endpoints.length === 0 ? (
              <p className="tr-empty" role="status">
                No endpoints with requests in the last {range}.
              </p>
            ) : (
              <EndpointsTable project={project} app={app} endpoints={endpoints} />
            )}
          </section>

          <section className="tr-card tr-card--table" aria-labelledby="ap-d-instances">
            <h2 id="ap-d-instances">SDK instances</h2>
            {status === null ? <Failed text={STATUS_LOAD_FAILED} href={appHref(project, slug)} /> : <Instances status={status} now={now} />}
          </section>

          <section className="tr-card tr-card--table" aria-labelledby="ap-d-deploys">
            <h2 id="ap-d-deploys">Recent deploys</h2>
            {deploys === null ? (
              <Failed text={DEPLOYS_LOAD_FAILED} href={appHref(project, slug)} />
            ) : deploys.length === 0 ? (
              <p className="tr-empty" role="status">
                No deploys of this app in the last {RANGE_LABEL[APP_DEPLOYS_RANGE]}. A deploy shows up when an SDK starts with a new <code>release</code> or the deploy API
                reports one.
              </p>
            ) : (
              <Deploys project={project} deploys={deploys} tz={tz} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** The header's facts: reporting state, health, SDKs with versions and environments. */
function AppFacts({ status, summary, now }: { status: AppStatus | null; summary: TrafficSummary | null; now: number }) {
  const health = summary ? appHealth(summary) : null;
  const sdks = status?.sdks ?? [];
  const envs = status?.environments ?? [];
  return (
    <dl className="ap-facts">
      <div>
        <dt>Status</dt>
        <dd>
          {status ? (
            <span className={`ap-pill ap-pill--${reportingTone(status.status)}`} title={REPORTING_HINT[status.status]}>
              <span className="ap-dot" aria-hidden="true" />
              {REPORTING_LABEL[status.status]}
            </span>
          ) : (
            <span className="ap-muted">{STATUS_LOAD_FAILED}</span>
          )}
          {status ? <span className="ap-muted">{formatLastSeen(status.last_seen_at, now)}</span> : null}
        </dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>
          {health ? (
            <span className={`ap-health ap-health--${health}`}>
              <span className="ap-dot" aria-hidden="true" />
              {HEALTH_LABEL[health]}
            </span>
          ) : (
            <span className="ap-muted">{TRAFFIC_LOAD_FAILED}</span>
          )}
        </dd>
      </div>
      <div>
        <dt>SDK</dt>
        <dd>
          {status && sdks.length === 0 ? <span className="ap-muted">No SDK reported yet</span> : null}
          {sdks.map((s) => {
            const update = sdkUpdate(s);
            return (
              <span key={s.name} className="ap-sdk">
                <code>{sdkVersions(s)}</code>
                {update ? <span className="ap-update">{update}</span> : null}
              </span>
            );
          })}
        </dd>
      </div>
      <div>
        <dt>Environments</dt>
        <dd>
          {status && envs.length === 0 ? <span className="ap-muted">None reported yet</span> : null}
          {envs.length > 0 ? (
            <ul className="ap-envs" aria-label="Environments">
              {envs.map((e) => (
                <li key={e.environment} className={`ap-pill ap-pill--${reportingTone(e.status)}`} title={REPORTING_HINT[e.status]}>
                  <span className="ap-dot" aria-hidden="true" />
                  {e.environment}
                </li>
              ))}
            </ul>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function Tiles({ summary: s }: { summary: TrafficSummary }) {
  return (
    <dl className="tr-tiles ap-tiles">
      <div>
        <dt>Requests</dt>
        <dd>
          <span className="tr-tile__value">{formatCount(s.requests)}</span>
        </dd>
      </div>
      <div>
        <dt>5xx rate</dt>
        <dd>
          <span className="tr-tile__value">{formatPercent(ratio(s.server_errors, s.requests))}</span>
          <span className="tr-tile__sub">{formatCount(s.server_errors)} 5xx</span>
        </dd>
      </div>
      <div>
        <dt>p95 response time</dt>
        <dd>
          <span className="tr-tile__value">{s.requests > 0 ? formatLatency(s.p95_ms) : "n/a"}</span>
        </dd>
      </div>
    </dl>
  );
}

function EndpointsTable({ project, app, endpoints }: { project: string; app: NamedApp; endpoints: EndpointTraffic[] }) {
  return (
    <table className="tr-table" aria-label="Top endpoints">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th scope="col" className="tr-num">
            Requests
          </th>
          <th scope="col" className="tr-num">
            5xx rate
          </th>
          <th scope="col" className="tr-num">
            p95
          </th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((ep) => (
          <tr key={`${ep.method} ${ep.path}`} className="tr-row">
            <td className="tr-ep" data-label="Endpoint">
              <a className="tr-ep__link" href={endpointPageHref(project, { method: ep.method.toUpperCase(), path: ep.path }, { app: app.id })}>
                <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
              </a>
            </td>
            <td className="tr-num" data-label="Requests">
              {formatCount(ep.requests)}
            </td>
            <td className="tr-num" data-label="5xx rate">
              {formatPercent(ratio(ep.server_errors, ep.requests))}
            </td>
            <td className="tr-num" data-label="p95">
              {formatLatency(ep.p95_ms)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Instances({ status, now }: { status: AppStatus; now: number }) {
  const all = status.instances ?? [];
  if (all.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No SDK instance has sent a heartbeat yet.
      </p>
    );
  }
  const shown = all.slice(0, APP_INSTANCES_SHOWN);
  return (
    <>
      <table className="tr-table" aria-label="SDK instances">
        <thead>
          <tr>
            <th scope="col">Instance</th>
            <th scope="col">Environment</th>
            <th scope="col">SDK</th>
            <th scope="col">Runtime</th>
            <th scope="col">Release</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.instance_id} className="tr-row">
              <td data-label="Instance">
                <code className="ap-mono">{i.instance_id}</code>
              </td>
              <td data-label="Environment">{i.environment || "–"}</td>
              <td data-label="SDK">
                <code className="ap-mono">{instanceSdk(i)}</code>
                {i.sdk_outdated && i.sdk_latest_version ? <span className="ap-update"> Update available: {i.sdk_latest_version}</span> : null}
              </td>
              <td data-label="Runtime">{i.runtime || "–"}</td>
              <td data-label="Release">{instanceRelease(i) || "–"}</td>
              <td data-label="Last seen">{formatLastSeen(i.last_seen_at, now).replace(/^Last seen /, "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {all.length > shown.length ? <p className="tr-cap">The {shown.length} most recently seen of {formatCount(all.length)} instances are listed.</p> : null}
    </>
  );
}

function Deploys({ project, deploys, tz }: { project: string; deploys: DeployChange[]; tz: string }) {
  return (
    <table className="tr-table" aria-label="Recent deploys">
      <thead>
        <tr>
          <th scope="col">Release</th>
          <th scope="col">Environment</th>
          <th scope="col">Deployed</th>
        </tr>
      </thead>
      <tbody>
        {deploys.map((d) => (
          <tr key={d.id} className="tr-row">
            <td className="tr-ep" data-label="Release">
              <a className="tr-ep__link" href={deployHref(project, d.id)}>
                <code>{d.release || shortCommit(d.commit) || "Unnamed deploy"}</code>
              </a>
            </td>
            <td data-label="Environment">{d.environment || "–"}</td>
            <td data-label="Deployed">{formatDeployTime(d.deployed_at, tz)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SetupState({ project, app }: { project: string; app: NamedApp }) {
  return (
    <div className="ap-notice ap-empty" role="status">
      <ObIcon name="info" />
      <div>
        <p>
          <b>No data from {app.name} yet.</b> Its traffic, endpoints, SDK instances and deploys show up here once an SDK sends requests with this app’s name: set{" "}
          <code>app_id</code> in the SDK config, or <code>APILENS_APP_ID={app.slug}</code>.
        </p>
        <p>
          <a className="cp-link" href={projectSectionHref(project, { slug: "sdk" })}>
            Set up the SDK
          </a>
        </p>
      </div>
    </div>
  );
}

function Failed({ text, href }: { text: string; href: string }) {
  return (
    <div className="ap-notice ap-notice--error" role="alert">
      <ObIcon name="info" />
      <p>
        {text}{" "}
        <a className="cp-link" href={href}>
          Try again
        </a>
      </p>
    </div>
  );
}
