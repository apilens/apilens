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
  MAX_ENDPOINT_SEARCH,
  nextEndpointSort,
  parseEndpointSearch,
  parseEndpointSort,
  scopeText,
  searchEndpoints,
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

/** The chart the page shows (`?chart=`): requests by status (the default), errors only, or response time. */
type ChartKind = "requests" | "errors" | "latency";
const readChart = (params: SearchParams): ChartKind => (params.chart === "latency" ? "latency" : params.chart === "errors" ? "errors" : "requests");
const CHART_TITLE: Record<ChartKind, string> = { requests: "Requests over time", errors: "Errors over time", latency: "Response time" };

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
  /** The page's search params as read, for the endpoints table's `?page=&per=` and `?chart=`. */
  params?: SearchParams;
}) {
  // Every endpoint the API listed, paged here; the range and environment links leave `page` out,
  // so they start again at page 1, and a page past the end (the list shrank while live) clamps.
  // Sorted by the column in `?sort=&dir=` (#1001) before paging, so a page is a slice of the order.
  // `?q=` (#1003) narrows the table to the paths matching it; the routes an app declared without
  // traffic (`discovered_only`) are not rows but one collapsed group under the table.
  const sort = parseEndpointSort(params);
  const search = parseEndpointSearch(params);
  const { active, declared } = splitDeclared(searchEndpoints(endpoints ?? [], search));
  const page = slicePage(sortEndpoints(active, sort, (id) => appName(apps, id)), parsePage(params));
  const sortHref = (key: EndpointSortKey) => hrefWithoutPage(trafficHref(project, {}), params, nextEndpointSort(sort, key));
  const scope = scopeText(q, q.app ? appName(apps, q.app) : undefined);
  // The App column (#976): which app serves each row, when the rows can be of several apps.
  const appColumn = apps && apps.length > 1 && !q.app ? apps : null;
  const chart = readChart(params);
  const chartHref = (c: ChartKind) => hrefWithoutPage(trafficHref(project, {}), params, { chart: c === "requests" ? null : c });
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
          <section className="tr-panel" aria-label={CHART_TITLE[chart]}>
            <MetricTabs summary={summary} chart={chart} chartHref={chartHref} />
            <div className="tr-panel__chart">
            {points === null ? (
              <ErrorState text={TIMESERIES_LOAD_FAILED} href={trafficHref(project, q)} />
            ) : chart === "latency" ? (
              <LatencyChart label="Response time" summary={`p95 of ${formatLatency(summary.p95_ms)} over ${scope}.`} rows={points} range={windowRange(q)} select={select} />
            ) : (
              <StatusChart
                label={chart === "errors" ? "Errors by status" : "Requests by status"}
                summary={`${formatCount(summary.requests)} requests in ${scope}: ${formatCount(summary.client_errors)} 4xx and ${formatCount(summary.server_errors)} 5xx.`}
                rows={chart === "errors" ? statusRows(points).map((r) => ({ ...r, successful: 0 })) : statusRows(points)}
                range={windowRange(q)}
                select={select}
              />
            )}
            </div>
          </section>


          <section className="tr-sec tr-sec--table" aria-labelledby="tr-endpoints">
            <div className="tr-sec__head">
              <h2 id="tr-endpoints">Endpoints</h2>
              <span className="tr-sec__meta">{endpoints ? `${formatCount(active.length)} with requests` : ""}</span>
              {endpoints && endpoints.length > 0 ? <EndpointSearch project={project} value={search} params={params} /> : null}
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
                    {search ? <>No endpoints with requests match “{search}” in {scope}.</> : <>No endpoints with requests in {scope}.</>}
                  </p>
                ) : apps && apps.length > 0 ? (
                  <EndpointRowMenus project={project} apps={apps}>
                    <EndpointsTable project={project} q={q} endpoints={page.rows} apps={appColumn} sort={sort} sortHref={sortHref} total={total} menus />
                  </EndpointRowMenus>
                ) : (
                  <EndpointsTable project={project} q={q} endpoints={page.rows} apps={appColumn} sort={sort} sortHref={sortHref} total={total} />
                )}
                {active.length > 0 ? <Pagination pathname={trafficHref(project, {})} params={params} total={page.window.total} label="Endpoints pages" /> : null}
                {declared.length > 0 ? <DeclaredRoutes project={project} q={q} routes={declared} apps={appColumn} scope={scope} open={search !== ""} /> : null}
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
 * The endpoints table's path search (#1003): a plain GET form, so it works before JavaScript,
 * keeping the rest of the URL (range, environment, app, sort, page size) and starting at page 1.
 */
function EndpointSearch({ project, value, params }: { project: string; value: string; params: SearchParams }) {
  const kept = Object.entries(params).flatMap(([k, v]) => (k === "q" || k === "page" || v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x] as const)));
  const clear = hrefWithoutPage(trafficHref(project, {}), params, { q: null });
  return (
    <form className="tr-search" role="search" aria-label="Endpoints" method="get" action={trafficHref(project, {})}>
      {kept.map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor="tr-search" className="tr-vh">
        Search endpoint paths
      </label>
      <span className="tr-search__box">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input id="tr-search" name="q" type="search" defaultValue={value} placeholder="Search paths" maxLength={MAX_ENDPOINT_SEARCH} autoComplete="off" spellCheck={false} />
      </span>
      {/* Enter searches; the button is there for screen readers. */}
      <button type="submit" className="tr-vh">
        Search
      </button>
      {value ? (
        <a className="cp-link" href={clear}>
          Clear
        </a>
      ) : null}
    </form>
  );
}

/**
 * The routes an app declared without traffic in the range (#1003), collapsed into one line under
 * the table so their zero counts never read like fast endpoints; open while a search narrows them.
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
 * The metric tabs over the chart, one panel with it: Requests, Errors and p95 are tabs (label,
 * value, one quiet line) that switch the chart, the current one underlined; Throughput and Apdex
 * read on their own at the end of the row. No dividers, no sparklines, no comparisons: the chart
 * under them carries the trend.
 */
function MetricTabs({ summary: s, chart, chartHref }: { summary: TrafficSummary; chart: ChartKind; chartHref: (c: ChartKind) => string }) {
  const errors = s.client_errors + s.server_errors;
  const rating = apdexRating(s.apdex);
  const tabs: { key: ChartKind; label: string; value: string; sub: ReactNode }[] = [
    { key: "requests", label: "Requests", value: formatCount(s.requests), sub: <>{formatPerMinute(s.requests_per_minute)}/min on average</> },
    {
      key: "errors",
      label: "Error rate",
      value: formatPercent(ratio(errors, s.requests)),
      sub: (
        <>
          <span className="tr-4xx">{formatCount(s.client_errors)} 4xx</span> · <span className="tr-5xx">{formatCount(s.server_errors)} 5xx</span>
        </>
      ),
    },
    {
      key: "latency",
      label: "p95 response time",
      value: formatLatency(s.p95_ms),
      sub: (
        <>
          p50 {formatLatency(s.p50_ms)} · p99 {formatLatency(s.p99_ms)}
        </>
      ),
    },
  ];
  return (
    <div className="tr-mtabs">
      <nav className="tr-mtabs__tabs" aria-label="Chart">
        {tabs.map((t) => (
          <a key={t.key} className="tr-mtab" href={chartHref(t.key)} aria-current={chart === t.key ? "page" : undefined}>
            <span className="tr-mtab__label">{t.label}</span>
            <span className="tr-mtab__value">
              <LiveNumber text={t.value} />
            </span>
            <span className="tr-mtab__sub">{t.sub}</span>
          </a>
        ))}
      </nav>
      <dl className="tr-mtabs__facts">
        <div>
          <dt>Throughput</dt>
          <dd>
            <LiveNumber text={`${formatCount(s.current_per_minute ?? 0)}/min`} />
          </dd>
        </div>
        <div>
          <dt>Apdex</dt>
          <dd>
            <LiveNumber text={formatApdex(s.apdex)} /> <span className="tr-mtabs__rating">{rating ?? ""}</span>
          </dd>
        </div>
      </dl>
    </div>
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
