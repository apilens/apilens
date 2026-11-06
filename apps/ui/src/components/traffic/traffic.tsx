import { RANGE_LABEL, formatCount, formatPerMinute, formatRate } from "@/lib/consumers";
import type { EndpointTraffic, NamedApp, TrafficPoint, TrafficSummary } from "@/lib/identity";
import {
  ENDPOINTS_LOAD_FAILED,
  TIMESERIES_LOAD_FAILED,
  TRAFFIC_LOAD_FAILED,
  TRAFFIC_RANGES,
  type TrafficState,
  apdexRating,
  endpointHref,
  formatApdex,
  formatLatency,
  scopeText,
  statusRows,
  trafficHref,
} from "@/lib/traffic";
import { EndpointRowMenu, EndpointRowMenus } from "../endpoint/row-menu";
import { ObIcon } from "../onboarding/ob";
import { LatencyChart, Sparkline, StatusChart } from "./charts";
import { EnvPicker } from "./env-picker";
import { LiveControl, LiveNumber } from "./live";
import "./traffic.css";

/**
 * `/<project>/traffic` (#592). The project's API traffic in a range and environment: tiles for
 * requests, errors (4xx and 5xx apart), p95 latency and Apdex; requests over time split by status
 * class and p95 over time; and the endpoints table, each row opening the endpoint's detail. The
 * scope is in the URL, so every view is a link, and the page reads itself again while live.
 * Each read is null when the API could not answer it.
 */
export function TrafficView({
  project,
  projectName,
  environments,
  query: q,
  summary,
  points,
  endpoints,
  apps = null,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: TrafficState;
  summary: TrafficSummary | null;
  points: TrafficPoint[] | null;
  endpoints: EndpointTraffic[] | null;
  /** The project's apps, whose endpoint settings each row's menu edits (#600); null hides the menus. */
  apps?: NamedApp[] | null;
}) {
  return (
    <div className="page tr">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Traffic</p>
        <h1 className="cp-lede">Traffic</h1>
        <p className="tr-lead">Requests, errors and response times of your API, overall and per endpoint.</p>
      </header>

      <div className="tr-bar">
        <div className="tr-bar__scope">
          <nav className="tr-seg" aria-label="Time range">
            {TRAFFIC_RANGES.map((r) => (
              <a key={r} href={trafficHref(project, { ...q, range: r })} aria-current={q.range === r ? "page" : undefined} title={`Last ${RANGE_LABEL[r]}`}>
                {r}
              </a>
            ))}
          </nav>
          <EnvPicker project={project} query={q} environments={environments} />
        </div>
        <LiveControl />
      </div>

      {summary === null ? (
        <LoadFailed text={TRAFFIC_LOAD_FAILED} href={trafficHref(project, q)} />
      ) : summary.requests === 0 ? (
        <div className="tr-notice" role="status">
          <ObIcon name="info" />
          <p>No requests in {scopeText(q)}. Once your app reports requests through the SDK, they show up here.</p>
        </div>
      ) : (
        <>
          <Tiles summary={summary} points={points ?? []} />
          <section className="tr-card" aria-labelledby="tr-over-time">
            <h2 id="tr-over-time">Requests over time</h2>
            {points === null ? (
              <LoadFailed text={TIMESERIES_LOAD_FAILED} href={trafficHref(project, q)} />
            ) : (
              <div className="tr-charts">
                <StatusChart
                  label="Requests by status"
                  summary={`${formatCount(summary.requests)} requests in ${scopeText(q)}: ${formatCount(summary.client_errors)} 4xx and ${formatCount(summary.server_errors)} 5xx.`}
                  rows={statusRows(points)}
                  range={q.range}
                />
                <LatencyChart
                  label="Response time"
                  summary={`p95 of ${formatLatency(summary.p95_ms)} over ${scopeText(q)}.`}
                  rows={points}
                  range={q.range}
                />
              </div>
            )}
          </section>
          <section className="tr-card tr-card--table" aria-labelledby="tr-endpoints">
            <h2 id="tr-endpoints">Endpoints</h2>
            {endpoints === null ? (
              <LoadFailed text={ENDPOINTS_LOAD_FAILED} href={trafficHref(project, q)} />
            ) : endpoints.length === 0 ? (
              <p className="tr-empty" role="status">
                No endpoints with requests in {scopeText(q)}.
              </p>
            ) : apps && apps.length > 0 ? (
              <EndpointRowMenus project={project} apps={apps}>
                <EndpointsTable project={project} q={q} endpoints={endpoints} menus />
              </EndpointRowMenus>
            ) : (
              <EndpointsTable project={project} q={q} endpoints={endpoints} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function LoadFailed({ text, href }: { text: string; href: string }) {
  return (
    <div className="tr-notice tr-notice--error" role="alert">
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

function Tiles({ summary: s, points }: { summary: TrafficSummary; points: TrafficPoint[] }) {
  const errors = s.client_errors + s.server_errors;
  const rating = apdexRating(s.apdex);
  return (
    <dl className="tr-tiles">
      <div>
        <dt>Requests</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatCount(s.requests)} />
          </span>
          <span className="tr-tile__sub">{formatPerMinute(s.requests_per_minute)} per minute</span>
          <Sparkline values={points.map((p) => p.requests)} />
        </dd>
      </div>
      <div>
        <dt>Error rate</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatRate(errors, s.requests)} />
          </span>
          <span className="tr-tile__sub">
            {formatCount(s.client_errors)} 4xx, {formatCount(s.server_errors)} 5xx
          </span>
          <Sparkline values={points.map((p) => p.client_errors + p.server_errors)} />
        </dd>
      </div>
      <div>
        <dt>p95 response time</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatLatency(s.p95_ms)} />
          </span>
          <span className="tr-tile__sub">
            p50 {formatLatency(s.p50_ms)}, p99 {formatLatency(s.p99_ms)}
          </span>
          <Sparkline values={points.map((p) => p.p95_ms)} />
        </dd>
      </div>
      <div>
        <dt>Apdex</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatApdex(s.apdex)} />
          </span>
          <span className="tr-tile__sub">{rating ?? "No requests to score"}</span>
          <span className="tr-spark" aria-hidden="true" />
        </dd>
      </div>
    </dl>
  );
}

function EndpointsTable({ project, q, endpoints, menus = false }: { project: string; q: TrafficState; endpoints: EndpointTraffic[]; menus?: boolean }) {
  return (
    <table className="tr-table" aria-label="Endpoints">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th scope="col" className="tr-num">
            Requests
          </th>
          <th scope="col" className="tr-num">
            4xx
          </th>
          <th scope="col" className="tr-num">
            5xx
          </th>
          <th scope="col" className="tr-num">
            p50
          </th>
          <th scope="col" className="tr-num">
            p95
          </th>
          <th scope="col" className="tr-num">
            Apdex
          </th>
          {menus ? (
            <th scope="col">
              <span className="ep-vh">Settings</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {endpoints.map((ep) => (
          <tr key={`${ep.method} ${ep.path}`} className="tr-row">
            <td className="tr-ep" data-label="Endpoint">
              <a className="tr-ep__link" href={endpointHref(project, ep, q)}>
                <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
              </a>
            </td>
            <td className="tr-num" data-label="Requests">
              {formatCount(ep.requests)}
            </td>
            <td className="tr-num" data-label="4xx">
              <Errors n={ep.client_errors} requests={ep.requests} />
            </td>
            <td className="tr-num" data-label="5xx">
              <Errors n={ep.server_errors} requests={ep.requests} />
            </td>
            <td className="tr-num" data-label="p50">
              {formatLatency(ep.p50_ms)}
            </td>
            <td className="tr-num" data-label="p95">
              {formatLatency(ep.p95_ms)}
            </td>
            <td className="tr-num" data-label="Apdex">
              {formatApdex(ep.apdex)}
            </td>
            {menus ? (
              <td className="ep-rowmenu__cell">
                <EndpointRowMenu method={ep.method} path={ep.path} />
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Errors({ n, requests }: { n: number; requests: number }) {
  if (n <= 0) return <span className="tr-muted">0</span>;
  return (
    <>
      {formatCount(n)} <span className="tr-muted">({formatRate(n, requests)})</span>
    </>
  );
}
