import { formatCount, formatPerMinute } from "@/lib/consumers";
import { compare } from "@/lib/compare";
import { bucketHrefs, exploreHrefFor } from "@/lib/explore";
import { formatPercent, ratio } from "@/lib/format";
import type { ReactNode } from "react";
import type { EndpointTraffic, NamedApp, QueryRange, TrafficPoint, TrafficSummary } from "@/lib/identity";
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
  const explore = (s: { status?: string; consumer_id?: string; method?: string; path?: string; app?: string }) => exploreHrefFor(project, { range: q.range, env: q.env, app: s.app ?? q.app, ...s });
  const total = summary?.requests ?? 0;
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
          <Tiles summary={summary} points={points ?? []} range={q.range} chart={chart} chartHref={chartHref} />

          <section className="tr-sec" aria-labelledby="tr-over-time">
            <div className="tr-sec__head">
              <h2 id="tr-over-time">{CHART_TITLE[chart]}</h2>
              <span className="tr-sec__meta">{scope}</span>
              <nav className="tr-switch" aria-label="Chart">
                <a href={chartHref("requests")} aria-current={chart === "requests" ? "page" : undefined}>
                  Requests
                </a>
                <a href={chartHref("errors")} aria-current={chart === "errors" ? "page" : undefined}>
                  Errors
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
                rows={chart === "errors" ? statusRows(points).map((r) => ({ ...r, successful: 0 })) : statusRows(points)}
                range={q.range}
                hrefs={bucketHrefs(project, q, points)}
              />
            )}
          </section>

          <TrafficMix
            statuses={statuses}
            methods={methods}
            consumers={consumers}
            apps={apps && apps.length > 1 && !q.app ? appCounts : null}
            appLabel={(id) => (apps ? appName(apps, id) : id)}
            statusHref={(cls) => explore({ status: cls })}
            consumerHref={(id) => explore({ consumer_id: id })}
            methodHref={(m) => trafficHref(project, { ...q, method: m })}
            appHref={(id) => trafficHref(project, { ...q, app: id })}
          />

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
 * The KPI strip: one frame of five compact cells split by hairlines, each its label with its
 * change against the previous period, its value, one line under it and, where the series has
 * one, a sparkline. Requests, Error rate and p95 are links that switch the chart to their series
 * (the current one is marked); Throughput and Apdex read on their own.
 */
function Tiles({
  summary: s,
  points,
  range,
  chart,
  chartHref,
}: {
  summary: TrafficSummary;
  points: TrafficPoint[];
  range: QueryRange;
  chart: ChartKind;
  chartHref: (c: ChartKind) => string;
}) {
  const errors = s.client_errors + s.server_errors;
  const rating = apdexRating(s.apdex);
  const p = s.previous;
  const cell = (key: string, label: string, compareTo: ReactNode, value: string, sub: ReactNode, spark: ReactNode, to?: ChartKind) => {
    const body = (
      <>
        <span className="tr-kpi__top">
          <span className="tr-kpi__label">{label}</span>
          {compareTo}
        </span>
        <span className="tr-kpi__value">
          <LiveNumber text={value} />
        </span>
        <span className="tr-kpi__sub">{sub}</span>
        {spark}
      </>
    );
    return (
      <div key={key} className={`tr-kpi${to && chart === to ? " is-on" : ""}`}>
        {to ? (
          <a className="tr-kpi__link" href={chartHref(to)} aria-current={chart === to ? "true" : undefined} aria-label={`${label} ${value}: show on the chart`}>
            {body}
          </a>
        ) : (
          <div className="tr-kpi__link">{body}</div>
        )}
      </div>
    );
  };
  return (
    <div className="tr-kpis" role="group" aria-label="Summary">
      {cell(
        "req",
        "Requests",
        <CompareLine comparison={compare(s.requests, p?.requests, { kind: "relative", better: "neither", range })} />,
        formatCount(s.requests),
        <>{formatPerMinute(s.requests_per_minute)}/min average</>,
        <Sparkline values={points.map((x) => x.requests)} hover={{ label: "Requests", range, points: points.map((x) => ({ ts: x.ts, text: formatCount(x.requests) })) }} />,
        "requests",
      )}
      {cell("tput", "Throughput", null, `${formatCount(s.current_per_minute ?? 0)}/min`, <>in the last full minute</>, null)}
      {cell(
        "err",
        "Error rate",
        <CompareLine comparison={p ? compare(ratio(errors, s.requests), ratio(p.client_errors + p.server_errors, p.requests), { kind: "rate", better: "down", range }) : null} />,
        formatPercent(ratio(errors, s.requests)),
        <>
          <span className="tr-4xx">{formatCount(s.client_errors)} 4xx</span> · <span className="tr-5xx">{formatCount(s.server_errors)} 5xx</span>
        </>,
        <Sparkline
          values={points.map((x) => (x.requests > 0 ? (x.client_errors + x.server_errors) / x.requests : 0))}
          hover={{ label: "Error rate", range, points: points.map((x) => ({ ts: x.ts, text: formatPercent(ratio(x.client_errors + x.server_errors, x.requests)) })) }}
        />,
        "errors",
      )}
      {cell(
        "p95",
        "p95 response time",
        <CompareLine comparison={compare(s.p95_ms, p?.p95_ms, { kind: "relative", better: "down", range })} />,
        formatLatency(s.p95_ms),
        <>
          p50 {formatLatency(s.p50_ms)} · p99 {formatLatency(s.p99_ms)}
        </>,
        <Sparkline values={points.map((x) => x.p95_ms)} hover={{ label: "p95", range, points: points.map((x) => ({ ts: x.ts, text: formatLatency(x.p95_ms) })) }} />,
        "latency",
      )}
      {cell("apdex", "Apdex", <CompareLine comparison={compare(s.apdex, p?.apdex, { kind: "score", better: "up", range })} />, formatApdex(s.apdex), <>{rating ?? "No requests to score"}</>, null)}
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

type MixPart = { key: string; label: string; count: number; href?: string; tone?: "ok" | "3xx" | "4xx" | "5xx" | "other" };

/** Status codes summed into classes, in class order. */
function statusClasses(statuses: FacetValue[]): MixPart[] {
  const sum: Record<string, number> = {};
  for (const s of statuses) {
    const c = `${String(s.value)[0]}xx`;
    sum[c] = (sum[c] ?? 0) + s.count;
  }
  return ["2xx", "3xx", "4xx", "5xx"].filter((c) => sum[c]).map((c) => ({ key: c, label: c, count: sum[c], tone: c === "2xx" ? "ok" : (c as MixPart["tone"]) }));
}

/** The top `n` parts and the rest of `total` as "Other". */
function topWithOther(parts: MixPart[], total: number, n: number): MixPart[] {
  const sorted = [...parts].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, n);
  const rest = total - top.reduce((x, p) => x + p.count, 0);
  return rest > 0 ? [...top, { key: "__other", label: "Other", count: rest, tone: "other" }] : top;
}

/**
 * Traffic mix: what the page's requests are made of, one thin 100% bar per dimension (status
 * class, method, consumer, and app when the page spans several), each segment its share; the
 * legend under a bar names the parts with their share. A part opens its requests in Explore
 * (status, consumer) or narrows the page to it (method, app). Neutral shades except status, whose
 * colours mean something.
 */
function TrafficMix({
  statuses,
  methods,
  consumers,
  apps,
  appLabel,
  statusHref,
  consumerHref,
  methodHref,
  appHref,
}: {
  statuses: FacetValue[] | null;
  methods: FacetValue[] | null;
  consumers: FacetValue[] | null;
  apps: FacetValue[] | null;
  appLabel: (id: string) => string;
  statusHref: (cls: string) => string;
  consumerHref: (id: string) => string;
  methodHref: (m: string) => string;
  appHref: (id: string) => string;
}) {
  // Every row shares one total: the requests the status facet counted (all codes).
  const total = (statuses ?? []).reduce((n, s) => n + s.count, 0);
  if (!statuses || total === 0) return null;
  const rows: { key: string; label: string; parts: MixPart[]; note?: string }[] = [
    { key: "status", label: "Status", parts: statusClasses(statuses).map((p) => ({ ...p, href: statusHref(p.key) })) },
    ...(methods?.length
      ? [{ key: "method", label: "Method", parts: topWithOther(methods.map((m) => ({ key: m.value, label: m.value.toUpperCase(), count: m.count, href: methodHref(m.value.toUpperCase()) })), total, 5) }]
      : []),
    ...(consumers
      ? [
          {
            key: "consumer",
            label: "Consumer",
            parts: topWithOther(
              consumers.map((c) => ({ key: c.value, label: c.label || c.value, count: c.count, href: consumerHref(c.value) })),
              total,
              5,
            ).map((p) => (p.key === "__other" ? { ...p, label: "Anonymous or other" } : p)),
          },
        ]
      : []),
    ...(apps?.length ? [{ key: "app", label: "App", parts: topWithOther(apps.map((a) => ({ key: a.value, label: appLabel(a.value), count: a.count, href: appHref(a.value) })), total, 5) }] : []),
  ];
  return (
    <section className="tr-sec" aria-labelledby="tr-mix">
      <div className="tr-sec__head">
        <h2 id="tr-mix">Traffic mix</h2>
        <span className="tr-sec__meta">share of {formatCount(total)} requests</span>
      </div>
      <div className="tr-mix">
        {rows.map((row) => (
          <div key={row.key} className="tr-mix__row">
            <span className="tr-mix__label">{row.label}</span>
            <div className="tr-mix__body">
              <div className="tr-mix__bar" role="img" aria-label={`${row.label}: ${row.parts.map((p) => `${p.label} ${formatPercent(p.count / total)}`).join(", ")}`}>
                {row.parts.map((p, i) => (
                  <span key={p.key} className={`tr-mix__seg tr-mix__seg--${p.tone ?? `n${Math.min(i, 4)}`}`} style={{ flexGrow: p.count }} title={`${p.label}: ${formatCount(p.count)} (${formatPercent(p.count / total)})`} />
                ))}
              </div>
              <ul className="tr-mix__legend">
                {row.parts.map((p, i) => {
                  const inner = (
                    <>
                      <span className={`tr-mix__sw tr-mix__seg--${p.tone ?? `n${Math.min(i, 4)}`}`} aria-hidden="true" />
                      <span className="tr-mix__name">{p.label}</span>
                      <span className="tr-mix__pct">{formatPercent(p.count / total)}</span>
                    </>
                  );
                  return <li key={p.key}>{p.href ? <a href={p.href}>{inner}</a> : <span>{inner}</span>}</li>;
                })}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </section>
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
