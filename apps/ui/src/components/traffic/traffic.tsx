import { formatCount, formatPerMinute } from "@/lib/consumers";
import { bucketHrefs, exploreHrefFor } from "@/lib/explore";
import { formatPercent, ratio } from "@/lib/format";
import type { ReactNode } from "react";
import type { EndpointTraffic, NamedApp, QueryRange, TrafficPoint, TrafficSummary } from "@/lib/identity";
import { formatSpan } from "@/lib/alerts";
import {
  windowRange,
  ENDPOINTS_LIMIT,
  ENDPOINTS_LOAD_FAILED,
  TIMESERIES_LOAD_FAILED,
  TRAFFIC_LOAD_FAILED,
  TRAFFIC_RANGES,
  type EndpointSort,
  type EndpointSortKey,
  type TrafficState,
  apdexRating,
  appName,
  declaredLabel,
  appOptions,
  ariaSort,
  endpointHref,
  formatApdex,
  formatLatency,
  nextEndpointSort,
  parseEndpointSort,
  scopeText,
  sortEndpoints,
  splitDeclared,
  statusRows,
  trafficHref,
} from "@/lib/traffic";
import { type SearchParams, hrefWithoutPage, parsePage, slicePage } from "@/lib/pagination";
import { EndpointRowMenu, EndpointRowMenus } from "../endpoint/row-menu";
import { ObIcon } from "../onboarding/ob";
import { Pagination } from "../pagination/pagination";
import { LatencyChart, StatusChart } from "./charts";
import { LiveNumber } from "./live";
import { TrafficToolbar } from "./toolbar";
import "./traffic.css";
import { ErrorState } from "../states";

type FacetValue = { value: string; label: string; count: number };

/** Time spent in words: as a latency under a minute, else `52 min`, `1 h 43 min`. */
const spentText = (ms: number) => (ms >= 60_000 ? formatSpan(ms / 1000) : formatLatency(ms));


/**
 * `/project/<project>/traffic` (#592): how the API is doing, summary first. One header row (the
 * title, range, environment, app and Live), the KPI strip (requests, throughput, error rate, p95,
 * Apdex, each against the previous period), one chart (requests by status or response time,
 * `?chart=`), the top endpoints, consumers and status codes (each row opens its requests in
 * Explore), then the endpoints table. Spacing follows three gaps only: 32px between sections,
 * 12px under a section's header, 16px between items. The scope is in the URL, so every view is a
 * link, and the page reads itself again while live. Each read is null when the API could not
 * answer it.
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
  consumers = null,
  statuses = null,
  methods = null,
  appCounts = null,
  audience = null,
  params = {},
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
  /** The busiest consumers and the status codes under the page's scope (request facets). */
  consumers?: FacetValue[] | null;
  statuses?: FacetValue[] | null;
  /** Requests per method and per app under the page's scope (request facets), for the mix. */
  methods?: FacetValue[] | null;
  appCounts?: FacetValue[] | null;
  /** Unique consumers of the range and environment (new vs returning) and their requests; null when unread. */
  audience?: Audience | null;
  /** The page's search params as read, for the endpoints table's `?page=&per=` and `?chart=`. */
  params?: SearchParams;
}) {
  // Every endpoint the API listed, paged here; the range and environment links leave `page` out,
  // so they start again at page 1, and a page past the end (the list shrank while live) clamps.
  // Sorted by the column in `?sort=&dir=` (#1001) before paging, so a page is a slice of the order.
  // The routes an app declared without traffic (`discovered_only`) are not rows but one collapsed
  // group under the table. Paths are narrowed by the Endpoint filter (sidebar, filter bar).
  const sort = parseEndpointSort(params);
  const { active, declared } = splitDeclared(endpoints ?? []);
  const page = slicePage(sortEndpoints(active, sort, (id) => appName(apps, id)), parsePage(params));
  const sortHref = (key: EndpointSortKey) => hrefWithoutPage(trafficHref(project, {}), params, nextEndpointSort(sort, key));
  const scope = scopeText(q, q.app ? appName(apps, q.app) : undefined);
  // The App column (#976): which app serves each row, when the rows can be of several apps.
  const appColumn = apps && apps.length > 1 && !q.app ? apps : null;
  const total = summary?.requests ?? 0;
  // A window picked on the chart filters this page (the default) or opens Explore: link templates
  // with the window's ends to fill in, keeping every other filter.
  const select = {
    page: trafficHref(project, { ...q, from: "__FROM__", to: "__TO__" }),
    explore: exploreHrefFor(project, { range: q.range, env: q.env, app: q.app, method: q.method, path: q.path, from: "__FROM__", to: "__TO__" }),
  };
  return (
    <div className="page tr">
      <TrafficToolbar
        project={project}
        query={q}
        environments={environments}
        apps={apps}
        methods={filterOptions(methods, endpoints, "method")}
        paths={filterOptions(null, endpoints, "path")}
      />

      {summary === null ? (
        <ErrorState text={TRAFFIC_LOAD_FAILED} href={trafficHref(project, q)} />
      ) : summary.requests === 0 ? (
        <div className="tr-notice" role="status">
          <ObIcon name="info" />
          <p>No requests in {scope}. Once your app reports requests through the SDK, they show up here.</p>
        </div>
      ) : (
        <>
          {points === null ? (
            <ErrorState text={TIMESERIES_LOAD_FAILED} href={trafficHref(project, q)} />
          ) : (
            <RedCharts summary={summary} points={points} range={windowRange(q)} scope={scope} select={select} audience={audience} />
          )}


          <section className="tr-sec tr-sec--table" aria-labelledby="tr-endpoints">
            <div className="tr-sec__head">
              <h2 id="tr-endpoints">Endpoints</h2>
              <span className="tr-sec__meta">{endpoints ? `${formatCount(active.length)} with requests` : ""}</span>
            </div>
            {endpoints === null ? (
              <ErrorState text={ENDPOINTS_LOAD_FAILED} href={trafficHref(project, q)} />
            ) : endpoints.length === 0 ? (
              <p className="tr-empty" role="status">
                No endpoints with requests in {scope}.
              </p>
            ) : (
              <div className="tr-tablewrap">
                {active.length === 0 ? (
                  <p className="tr-empty" role="status">
                    No endpoints with requests in {scope}.
                  </p>
                ) : apps && apps.length > 0 ? (
                  <EndpointRowMenus project={project} apps={apps}>
                    <EndpointsTable project={project} q={q} endpoints={page.rows} apps={appColumn} sort={sort} sortHref={sortHref} total={total} menus />
                  </EndpointRowMenus>
                ) : (
                  <EndpointsTable project={project} q={q} endpoints={page.rows} apps={appColumn} sort={sort} sortHref={sortHref} total={total} />
                )}
                {active.length > 0 ? <Pagination pathname={trafficHref(project, {})} params={params} total={page.window.total} label="Endpoints pages" /> : null}
                {declared.length > 0 ? <DeclaredRoutes project={project} q={q} routes={declared} apps={appColumn} scope={scope} open={false} /> : null}
                {endpoints.length >= ENDPOINTS_LIMIT ? <p className="tr-cap">The {formatCount(ENDPOINTS_LIMIT)} busiest endpoints are listed.</p> : null}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * The routes an app declared without traffic in the range (#1003), collapsed into one line under
 * the table so their zero counts never read like fast endpoints.
 */
function DeclaredRoutes({ project, q, routes, apps, scope, open }: { project: string; q: TrafficState; routes: EndpointTraffic[]; apps: NamedApp[] | null; scope: string; open: boolean }) {
  return (
    <details className="tr-declared" open={open}>
      <summary>{declaredLabel(routes.length)}</summary>
      <p className="tr-declared__lead">Your apps declared these routes, but none was called in {scope}.</p>
      <ul aria-label="Declared routes without traffic">
        {routes.map((ep) => (
          <li key={`${ep.app_id} ${ep.method} ${ep.path}`}>
            <a className="tr-declared__link" href={endpointHref(project, ep, { ...q, app: ep.app_id || q.app })}>
              <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
            </a>
            {apps ? <span className="tr-muted"> · {appName(apps, ep.app_id)}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}


/**
 * Rate, errors, duration: the three signals of an API's health side by side, as service
 * dashboards lay them out (Datadog's service page, Apitally's traffic), so none hides behind a
 * switch. Each card is its label with one aside, its number and a small chart without axes (the
 * tooltip reads each bucket): requests as one series (throughput now aside), errors by class
 * (4xx, 5xx), p95 (p50 and p99 aside). A drag or click on
 * any chart picks a window that filters the page (select mode).
 */
function RedCharts({
  summary: s,
  points,
  range,
  scope,
  select,
  audience,
}: {
  summary: TrafficSummary;
  points: TrafficPoint[];
  range: QueryRange;
  scope: string;
  select: { page: string; explore: string };
  audience: Audience | null;
}) {
  const errors = s.client_errors + s.server_errors;
  const rows = statusRows(points);
  // Requests read as one series (the Errors card carries the split), so the eye sees volume.
  const volume = rows.map((r) => ({ ...r, successful: r.successful + r.client_errors + r.server_errors, client_errors: 0, server_errors: 0 }));
  return (
    <section className="tr-red" aria-label="Requests, errors and response time">
      <article className="tr-panel tr-red__card">
        <header className="tr-red__head">
          <h2 className="tr-red__label">Requests</h2>
          <span className="tr-red__aside">{formatCount(s.current_per_minute ?? 0)}/min now</span>
        </header>
        <p className="tr-red__value">
          <LiveNumber text={formatCount(s.requests)} />
        </p>
        <StatusChart label="Requests" summary={`${formatCount(s.requests)} requests in ${scope}.`} rows={volume} range={range} select={select} />
      </article>
      <article className="tr-panel tr-red__card">
        <header className="tr-red__head">
          <h2 className="tr-red__label">Errors</h2>
          <span className="tr-red__aside">
            <span className="tr-4xx">{formatCount(s.client_errors)} 4xx</span> · <span className="tr-5xx">{formatCount(s.server_errors)} 5xx</span>
          </span>
        </header>
        <p className="tr-red__value">
          <LiveNumber text={formatPercent(ratio(errors, s.requests))} />
        </p>
        <StatusChart
          label="Errors by status"
          summary={`${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx in ${scope}.`}
          rows={rows.map((r) => ({ ...r, successful: 0 }))}
          range={range}
          select={select}
        />
      </article>
      <article className="tr-panel tr-red__card">
        <header className="tr-red__head">
          <h2 className="tr-red__label">Response time</h2>
          <span className="tr-red__aside">
            p50 {formatLatency(s.p50_ms)} · p99 {formatLatency(s.p99_ms)}
          </span>
        </header>
        <p className="tr-red__value">
          <LiveNumber text={formatLatency(s.p95_ms)} />
          <span className="tr-red__unit">p95</span>
        </p>
        <LatencyChart label="Response time" summary={`p95 of ${formatLatency(s.p95_ms)} over ${scope}.`} rows={points} range={range} select={select} />
      </article>
      {audience ? <ConsumersCard audience={audience} /> : null}
    </section>
  );
}

/**
 * The filter bar's suggestions for a field: the facet's counts when there are any, else the
 * values in the endpoints list (requests summed), busiest first.
 */
function filterOptions(facet: FacetValue[] | null, endpoints: EndpointTraffic[] | null, key: "method" | "path"): { value: string; label: string; count?: number }[] {
  if (facet?.length) return facet.map((f) => ({ value: f.value.toUpperCase(), label: f.value.toUpperCase(), count: f.count }));
  const m = new Map<string, number>();
  for (const ep of endpoints ?? []) {
    const v = key === "method" ? ep.method.toUpperCase() : ep.path;
    m.set(v, (m.get(v) ?? 0) + ep.requests);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: value, count }));
}

function EndpointsTable({
  project,
  q,
  endpoints,
  apps = null,
  menus = false,
  sort,
  sortHref,
  total,
}: {
  project: string;
  q: TrafficState;
  endpoints: EndpointTraffic[];
  /** The page's requests, for each row's share bar. */
  total: number;
  /** The project's apps when the table shows the App column; null leaves it out. */
  apps?: NamedApp[] | null;
  menus?: boolean;
  /** The table's order (#1001) and the link each header sorts by. */
  sort: EndpointSort;
  sortHref: (key: EndpointSortKey) => string;
}) {
  const header = (key: EndpointSortKey, label: string, num = true) => (
    <SortHeader sort={sort} col={key} href={sortHref(key)} num={num}>
      {label}
    </SortHeader>
  );
  return (
    <table className="tr-table" aria-label="Endpoints">
      <thead>
        <tr>
          {header("endpoint", "Endpoint", false)}
          {apps ? header("app", "App", false) : null}
          {header("requests", "Requests")}
          {header("client_errors", "4xx")}
          {header("server_errors", "5xx")}
          {header("p50", "p50")}
          {header("p95", "p95")}
          {header("apdex", "Apdex")}
          <th scope="col" className="tr-num">
            Time spent
          </th>
          {menus ? (
            <th scope="col">
              <span className="ep-vh">Settings</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {endpoints.map((ep) => {
          // The row's requests in Explore (#977): this endpoint of the row's app, in the page's scope.
          const drill = (s: { status?: string; latency_min?: number }) =>
            exploreHrefFor(project, { range: q.range, env: q.env, app: ep.app_id || q.app, method: ep.method, path: ep.path, ...s });
          return (
            <tr key={`${ep.app_id} ${ep.method} ${ep.path}`} className="tr-row">
              <td className="tr-ep" data-label="Endpoint">
                <a className="tr-ep__link" href={endpointHref(project, ep, { ...q, app: ep.app_id || q.app })}>
                  <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
                </a>
              </td>
              {apps ? (
                <td className="tr-app" data-label="App">
                  {appName(apps, ep.app_id)}
                </td>
              ) : null}
              <td className="tr-num" data-label="Requests" title={total > 0 ? `${formatPercent(ep.requests / total)} of all requests` : undefined}>
                {formatCount(ep.requests)}
              </td>
              <td className="tr-num" data-label="4xx">
                <Errors n={ep.client_errors} requests={ep.requests} href={drill({ status: "4xx" })} label="4xx responses" />
              </td>
              <td className="tr-num" data-label="5xx">
                <Errors n={ep.server_errors} requests={ep.requests} href={drill({ status: "5xx" })} label="5xx responses" />
              </td>
              <td className="tr-num" data-label="p50">
                {formatLatency(ep.p50_ms)}
              </td>
              <td className="tr-num" data-label="p95">
                {ep.requests > 0 && ep.p95_ms > 0 ? (
                  <a
                    className="tr-drill"
                    href={drill({ latency_min: ep.p95_ms })}
                    title="See the requests at p95 or slower in Explore"
                    aria-label={`p95 ${formatLatency(ep.p95_ms)}: requests at p95 or slower in Explore`}
                  >
                    {formatLatency(ep.p95_ms)}
                  </a>
                ) : (
                  formatLatency(ep.p95_ms)
                )}
              </td>
              <td className="tr-num" data-label="Apdex">
                {formatApdex(ep.apdex)}
              </td>
              <td className="tr-num" data-label="Time spent" title="Requests × average response time: where the API spends its time">
                {ep.total_time_ms !== undefined ? spentText(ep.total_time_ms) : <span className="tr-muted">–</span>}
              </td>
              {menus ? (
                <td className="ep-rowmenu__cell">
                  <EndpointRowMenu method={ep.method} path={ep.path} appId={ep.app_id} />
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * A sortable column header (#1001): a link ordering the table by the column, the other way when it
 * already is; `aria-sort` names the current order.
 */
function SortHeader({ sort, col, href, num, children }: { sort: EndpointSort; col: EndpointSortKey; href: string; num: boolean; children: string }) {
  const dir = ariaSort(sort, col);
  return (
    <th scope="col" className={num ? "tr-num" : undefined} aria-sort={dir}>
      <a className="tr-sort" href={href}>
        {children}
      </a>
    </th>
  );
}

/** An error count and its share; with `href` (#977) the count opens those requests in Explore. */
function Errors({ n, requests, href, label }: { n: number; requests: number; href?: string; label?: string }) {
  if (n <= 0) return <span className="tr-muted">0</span>;
  return (
    <>
      {href ? (
        <a className="tr-drill" href={href} title={label ? `See these ${label} in Explore` : undefined} aria-label={label ? `${formatCount(n)} ${label} in Explore` : undefined}>
          {formatCount(n)}
        </a>
      ) : (
        formatCount(n)
      )}{" "}
      <span className="tr-muted">({formatPercent(ratio(n, requests))})</span>
    </>
  );
}

/** The Consumers card's numbers: unique consumers of the range, new vs returning, and their requests. */
export type Audience = { consumers: number; new: number; returning: number; requests: number };

/**
 * Consumers beside the RED cards, numbers only: unique consumers (the users the SDK identified)
 * with requests in the range, how many are new (first seen in it) or returning, and the requests
 * they made. It follows the range and environment; app, method, endpoint and a picked window
 * don't narrow it (the consumers read is kept by consumer, not route).
 */
function ConsumersCard({ audience: a }: { audience: Audience }) {
  return (
    <article className="tr-panel tr-red__card tr-red__card--stat">
      <header className="tr-red__head">
        <h2 className="tr-red__label">Consumers</h2>
        <span className="tr-red__aside" title="Users the SDK identified, in this range and environment">
          unique
        </span>
      </header>
      <p className="tr-red__value">
        <LiveNumber text={formatCount(a.consumers)} />
      </p>
      <dl className="tr-cstats">
        <div>
          <dt>New</dt>
          <dd>{formatCount(a.new)}</dd>
        </div>
        <div>
          <dt>Returning</dt>
          <dd>{formatCount(a.returning)}</dd>
        </div>
        <div>
          <dt>Requests</dt>
          <dd>{formatCount(a.requests)}</dd>
        </div>
      </dl>
    </article>
  );
}
