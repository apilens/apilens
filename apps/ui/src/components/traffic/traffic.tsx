import { formatCount, formatPerMinute } from "@/lib/consumers";
import { compare } from "@/lib/compare";
import { bucketHrefs, exploreHrefFor } from "@/lib/explore";
import { formatPercent, ratio } from "@/lib/format";
import type { ReactNode } from "react";
import type { EndpointTraffic, NamedApp, QueryRange, TrafficPoint, TrafficSummary } from "@/lib/identity";
import { reasonPhrase } from "@/lib/http-status";
import { formatSpan } from "@/lib/alerts";
import {
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
import { LatencyChart, Sparkline, StatusChart } from "./charts";
import { CompareLine } from "./compare";
import { LiveNumber } from "./live";
import { TrafficToolbar } from "./toolbar";
import "./traffic.css";
import { ErrorState } from "../states";

type FacetValue = { value: string; label: string; count: number };

/** Time spent in words: as a latency under a minute, else `52 min`, `1 h 43 min`. */
const spentText = (ms: number) => (ms >= 60_000 ? formatSpan(ms / 1000) : formatLatency(ms));

/** The chart the page shows (`?chart=`): requests by status (the default) or response time. */
type ChartKind = "requests" | "latency";
const readChart = (params: SearchParams): ChartKind => (params.chart === "latency" ? "latency" : "requests");

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
  const explore = (s: { status?: string; consumer_id?: string; method?: string; path?: string; app?: string }) => exploreHrefFor(project, { range: q.range, env: q.env, app: s.app ?? q.app, ...s });
  const total = summary?.requests ?? 0;
  return (
    <div className="page tr">
      <TrafficToolbar project={project} query={q} environments={environments} apps={apps} />

      {summary === null ? (
        <ErrorState text={TRAFFIC_LOAD_FAILED} href={trafficHref(project, q)} />
      ) : summary.requests === 0 ? (
        <div className="tr-notice" role="status">
          <ObIcon name="info" />
          <p>No requests in {scope}. Once your app reports requests through the SDK, they show up here.</p>
        </div>
      ) : (
        <>
          <Tiles summary={summary} points={points ?? []} range={q.range} />

          <section className="tr-sec" aria-labelledby="tr-over-time">
            <div className="tr-sec__head">
              <h2 id="tr-over-time">{chart === "latency" ? "Response time" : "Requests over time"}</h2>
              <span className="tr-sec__meta">{scope}</span>
              <nav className="tr-switch" aria-label="Chart">
                <a href={chartHref("requests")} aria-current={chart === "requests" ? "page" : undefined}>
                  Requests
                </a>
                <a href={chartHref("latency")} aria-current={chart === "latency" ? "page" : undefined}>
                  Response time
                </a>
              </nav>
            </div>
            {points === null ? (
              <ErrorState text={TIMESERIES_LOAD_FAILED} href={trafficHref(project, q)} />
            ) : chart === "latency" ? (
              <LatencyChart label="Response time" summary={`p95 of ${formatLatency(summary.p95_ms)} over ${scope}.`} rows={points} range={q.range} />
            ) : (
              <StatusChart
                label="Requests by status"
                summary={`${formatCount(summary.requests)} requests in ${scope}: ${formatCount(summary.client_errors)} 4xx and ${formatCount(summary.server_errors)} 5xx.`}
                rows={statusRows(points)}
                range={q.range}
                hrefs={bucketHrefs(project, q, points)}
              />
            )}
          </section>

          <section className="tr-cards" aria-label="Breakdown">
            <TopCard
              title="Top endpoints"
              total={total}
              rows={
                endpoints === null
                  ? null
                  : [...active]
                      .sort((a, b) => b.requests - a.requests)
                      .slice(0, 5)
                      .map((ep) => ({
                        key: `${ep.app_id} ${ep.method} ${ep.path}`,
                        label: (
                          <>
                            <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
                          </>
                        ),
                        text: `${ep.method.toUpperCase()} ${ep.path}`,
                        count: ep.requests,
                        href: endpointHref(project, ep, { ...q, app: ep.app_id || q.app }),
                      }))
              }
              empty="No endpoints with requests."
            />
            <TopCard
              title="Top consumers"
              total={total}
              rows={
                consumers === null
                  ? null
                  : consumers.slice(0, 5).map((c) => ({ key: c.value, label: c.label || c.value, text: c.label || c.value, count: c.count, href: explore({ consumer_id: c.value }) }))
              }
              empty="No identified consumers."
            />
            <TopCard
              title="Status codes"
              total={total}
              rows={
                statuses === null
                  ? null
                  : [...statuses]
                      .sort((a, b) => b.count - a.count)
                      .slice(0, 5)
                      .map((st) => {
                        const code = Number(st.value);
                        return {
                          key: st.value,
                          label: (
                            <>
                              <code className={`tr-code tr-code--${code >= 500 ? "5xx" : code >= 400 ? "4xx" : "ok"}`}>{st.value}</code> <span className="tr-muted">{reasonPhrase(code)}</span>
                            </>
                          ),
                          text: `${st.value} ${reasonPhrase(code)}`,
                          count: st.count,
                          tone: code >= 500 ? "5xx" : code >= 400 ? "4xx" : undefined,
                          href: explore({ status: st.value }),
                        };
                      })
              }
              empty="No responses."
            />
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
 * A breakdown card: its title, then its top five, each a name, the count and a thin bar of its
 * size against the list's largest (the title says its share of the page's requests); a row opens
 * its requests (or its endpoint). Fixed at five rows,
 * so the three cards line up.
 */
function TopCard({
  title,
  total,
  rows,
  empty,
}: {
  title: string;
  total: number;
  rows: { key: string; label: ReactNode; text: string; count: number; href: string; tone?: "4xx" | "5xx" }[] | null;
  empty: string;
}) {
  return (
    <section className="tr-top" aria-label={title}>
      <h2 className="tr-top__title">{title}</h2>
      {rows === null ? (
        <p className="tr-empty">Couldn’t load this just now.</p>
      ) : rows.length === 0 ? (
        <p className="tr-empty">{empty}</p>
      ) : (
        <ol className="tr-top__list">
          {rows.map((r) => {
            // The bar is the row's size against the list's largest (as top-N lists draw it); the
            // title gives its share of all the page's requests.
            const max = Math.max(...rows.map((x) => x.count), 1);
            const share = total > 0 ? Math.min(1, r.count / total) : 0;
            const bar = r.count / max;
            return (
              <li key={r.key}>
                <a className="tr-top__row" href={r.href} title={`${r.text}: ${formatCount(r.count)} (${formatPercent(share)})`}>
                  <span className="tr-top__name">{r.label}</span>
                  <span className="tr-top__n">{formatCount(r.count)}</span>
                  <span className={`tr-top__bar${r.tone ? ` is-${r.tone}` : ""}`} aria-hidden="true">
                    <span style={{ width: `${Math.max(bar * 100, 1)}%` }} />
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
    </section>
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
 * The KPI strip: one frame of five cells split by hairlines, each its label, its value, a line
 * under it and how it compares with the previous period: requests, throughput (the last full
 * minute), error rate (4xx and 5xx apart), p95 and Apdex. Sparklines where the series has one.
 */
function Tiles({ summary: s, points, range }: { summary: TrafficSummary; points: TrafficPoint[]; range: QueryRange }) {
  const errors = s.client_errors + s.server_errors;
  const rating = apdexRating(s.apdex);
  const p = s.previous;
  return (
    <dl className="tr-tiles">
      <div>
        <dt>Requests</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatCount(s.requests)} />
          </span>
          <CompareLine comparison={compare(s.requests, p?.requests, { kind: "relative", better: "neither", range })} />
          <Sparkline values={points.map((x) => x.requests)} hover={{ label: "Requests", range, points: points.map((x) => ({ ts: x.ts, text: formatCount(x.requests) })) }} />
        </dd>
      </div>
      <div>
        <dt>Throughput</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={`${formatCount(s.current_per_minute ?? 0)}/min`} />
          </span>
          <span className="tr-tile__sub">now · average {formatPerMinute(s.requests_per_minute)}/min</span>
        </dd>
      </div>
      <div>
        <dt>Error rate</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatPercent(ratio(errors, s.requests))} />
          </span>
          <span className="tr-tile__sub">
            <span className="tr-4xx">{formatCount(s.client_errors)} 4xx</span> · <span className="tr-5xx">{formatCount(s.server_errors)} 5xx</span>
          </span>
          <CompareLine comparison={p ? compare(ratio(errors, s.requests), ratio(p.client_errors + p.server_errors, p.requests), { kind: "rate", better: "down", range }) : null} />
          <Sparkline
            values={points.map((x) => (x.requests > 0 ? (x.client_errors + x.server_errors) / x.requests : 0))}
            hover={{ label: "Error rate", range, points: points.map((x) => ({ ts: x.ts, text: formatPercent(ratio(x.client_errors + x.server_errors, x.requests)) })) }}
          />
        </dd>
      </div>
      <div>
        <dt>p95 response time</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatLatency(s.p95_ms)} />
          </span>
          <span className="tr-tile__sub">
            p50 {formatLatency(s.p50_ms)} · p99 {formatLatency(s.p99_ms)}
          </span>
          <CompareLine comparison={compare(s.p95_ms, p?.p95_ms, { kind: "relative", better: "down", range })} />
          <Sparkline values={points.map((x) => x.p95_ms)} hover={{ label: "p95", range, points: points.map((x) => ({ ts: x.ts, text: formatLatency(x.p95_ms) })) }} />
        </dd>
      </div>
      <div>
        <dt>Apdex</dt>
        <dd>
          <span className="tr-tile__value">
            <LiveNumber text={formatApdex(s.apdex)} />
          </span>
          <span className="tr-tile__sub">{rating ?? "No requests to score"}</span>
          <CompareLine comparison={compare(s.apdex, p?.apdex, { kind: "score", better: "up", range })} />
        </dd>
      </div>
    </dl>
  );
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
              <td className="tr-num tr-req" data-label="Requests">
                <span className="tr-share" aria-hidden="true">
                  <span style={{ width: `${total > 0 ? Math.max((ep.requests / total) * 100, 1) : 0}%` }} />
                </span>
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
