import { compare } from "@/lib/compare";
import { formatCount } from "@/lib/consumers";
import { latencyBucketLabel } from "@/lib/endpoint-detail";
import { exploreHrefFor, logTime, statusClass } from "@/lib/explore";
import { formatPercent } from "@/lib/format";
import type { AppSettings, EndpointTraffic, NamedApp, QueryRange, RequestRow, TrafficLatency } from "@/lib/identity";
import {
  PERFORMANCE_LOAD_FAILED,
  PERF_ENDPOINTS_LOAD_FAILED,
  type PerformanceState,
  SLOWEST_LOAD_FAILED,
  apdexExplanation,
  byTimeSpent,
  endpointLatencyHref,
  formatTimeSpent,
  perfScopeText,
  performanceHref,
  slowRequestHref,
} from "@/lib/performance";
import { zoneLabel } from "@/lib/time-zone";
import { TRAFFIC_RANGES, appName, appOptions, formatLatency } from "@/lib/traffic";
import { Histogram, LinesChart } from "../endpoint/charts";
import { ScopeSelect } from "../endpoint/filters";
import { ObIcon } from "../onboarding/ob";
import { PageHeader } from "../page-header";
import { RangePicker } from "../range-picker";
import { Sparkline } from "../traffic/charts";
import { CompareLine } from "../traffic/compare";
import { LiveControl, LiveNumber } from "../traffic/live";
import { ApdexTile } from "./apdex";
import { AppThresholdMenu } from "./threshold";
import "../traffic/traffic.css";
import "../endpoint/endpoint.css";
import "./performance.css";

/**
 * The project's apps (null when the API could not answer), the app the settings dialog opens on
 * and its threshold, and whether that app is the page's whole scope (#976).
 */
export interface AppThresholdLoad {
  apps: NamedApp[] | null;
  app: NamedApp | null;
  settings: AppSettings | null;
  scoped: boolean;
}

/**
 * `/project/<project>/performance` (#595). How fast the project's API answers in a range and environment:
 * p50, p75 and p95 tiles with their trend, the Apdex with a gauge and how it is scored, the
 * response-time histogram, then why it is slow (#1001): the slowest requests, each opening in
 * Explore, and the endpoints by time spent (requests × average), each opening its Response times
 * tab (where the endpoint's own threshold is set). The app settings dialog edits the app-wide
 * response time threshold. The scope is in the URL; each read is null when the API could not answer it.
 */
export function PerformanceView({
  project,
  projectName,
  environments,
  query: q,
  latency,
  endpoints,
  slowest,
  threshold,
  now = Date.now(),
  tz,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: PerformanceState;
  latency: TrafficLatency | null;
  endpoints: EndpointTraffic[] | null;
  /** The slowest requests of the scope (#1001), slowest first. */
  slowest: RequestRow[] | null;
  threshold: AppThresholdLoad;
  /** When the page was read, for the requests' day. */
  now?: number;
  /** The user's time zone. */
  tz: string;
}) {
  const href = (patch: Partial<PerformanceState>) => performanceHref(project, { ...q, ...patch });
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  const { apps, app, settings, scoped } = threshold;
  // Only an app that is the page's whole scope names its threshold: across apps T differs (#976).
  const explanation = apdexExplanation(scoped && app && settings ? { name: app.name, thresholdMs: settings.apdex_threshold_ms } : null);
  const scope = perfScopeText(q, q.app ? appName(apps, q.app) : undefined);
  // The App column (#976): which app served each row, when the rows can be of several apps.
  const appColumn = apps && apps.length > 1 && !q.app ? apps : null;

  return (
    <div className="page tr pf">
      <PageHeader
        project={project}
        projectName={projectName}
        title="Performance"
        lead="How fast your API answers: response time percentiles, Apdex, the slowest requests and where the time goes."
        actions={<RangePicker options={TRAFFIC_RANGES} value={q.range} href={(r) => href({ range: r })} />}
      />

      <div className="tr-bar">
        <div className="tr-bar__scope">
          <ScopeSelect
            label="Environment"
            value={q.env}
            options={[{ value: "", label: "All environments", href: href({ env: "" }) }, ...envs.map((e) => ({ value: e, label: e, href: href({ env: e }) }))]}
          />
          {apps && (apps.length > 1 || q.app) ? (
            <ScopeSelect label="App" value={q.app} options={appOptions(apps, q.app).map((o) => ({ ...o, href: href({ app: o.value }) }))} />
          ) : null}
        </div>
        <div className="pf-bar__end">
          {apps && app && settings ? <AppThresholdMenu key={app.id} project={project} apps={apps} app={app} settings={settings} /> : null}
          <LiveControl />
        </div>
      </div>
      {app && !settings ? (
        <p className="ep-note pf-note" role="status">
          We couldn’t load the response time threshold of {app.name} just now.
        </p>
      ) : null}

      {latency === null ? (
        <LoadFailed text={PERFORMANCE_LOAD_FAILED} href={href({})} />
      ) : latency.summary.requests === 0 ? (
        <div className="tr-notice" role="status">
          <ObIcon name="info" />
          <p>No requests in {scope}. Once your app reports requests through the SDK, their response times show up here.</p>
        </div>
      ) : (
        <>
          <Tiles latency={latency} explanation={explanation} range={q.range} p95Href={exploreHrefFor(project, { range: q.range, env: q.env, app: q.app, latency_min: latency.summary.p95_ms })} />
          <section className="tr-card" aria-labelledby="pf-over-time">
            <h2 id="pf-over-time">Response time over time</h2>
            <LinesChart
              label="Response time percentiles"
              summary={`p50 ${formatLatency(latency.summary.p50_ms)}, p75 ${formatLatency(latency.summary.p75_ms)} and p95 ${formatLatency(latency.summary.p95_ms)} in ${scope}.`}
              rows={latency.points ?? []}
              series={[
                { key: "p50_ms", label: "p50", className: "ep-c-p50" },
                { key: "p75_ms", label: "p75", className: "ep-c-p75" },
                { key: "p95_ms", label: "p95", className: "ep-c-p95" },
              ]}
              unit="ms"
              range={q.range}
            />
          </section>
          <section className="tr-card" aria-labelledby="pf-hist">
            <h2 id="pf-hist">Response time distribution</h2>
            <HistogramCard latency={latency} />
          </section>
        </>
      )}

      {latency === null || latency.summary.requests > 0 ? (
        <>
          <section className="tr-card tr-card--table" aria-labelledby="pf-slowest">
            <h2 id="pf-slowest">Slowest requests</h2>
            {slowest === null ? (
              <LoadFailed text={SLOWEST_LOAD_FAILED} href={href({})} />
            ) : (
              <SlowestTable project={project} q={q} scope={scope} requests={slowest} apps={appColumn} now={now} tz={tz} />
            )}
          </section>
          <section className="tr-card tr-card--table" aria-labelledby="pf-time-spent">
            <h2 id="pf-time-spent">Time spent</h2>
            {endpoints === null ? (
              <LoadFailed text={PERF_ENDPOINTS_LOAD_FAILED} href={href({})} />
            ) : (
              <TimeSpentTable project={project} q={q} scope={scope} endpoints={endpoints} apps={appColumn} />
            )}
          </section>
        </>
      ) : null}
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

function Tiles({
  latency,
  explanation,
  range,
  p95Href,
}: {
  latency: TrafficLatency;
  explanation: readonly string[];
  range: QueryRange;
  /** The requests at p95 or slower in Explore (#977). */
  p95Href: string;
}) {
  const s = latency.summary;
  const prev = latency.previous;
  const points = latency.points ?? [];
  const tiles = [
    { label: "p50 response time", short: "p50", value: s.p50_ms, sub: `average ${formatLatency(s.avg_ms)}`, key: "p50_ms" as const },
    { label: "p75 response time", short: "p75", value: s.p75_ms, sub: `p90 ${formatLatency(s.p90_ms)}`, key: "p75_ms" as const },
    { label: "p95 response time", short: "p95", value: s.p95_ms, sub: `p99 ${formatLatency(s.p99_ms)}, slowest ${formatLatency(s.max_ms)}`, key: "p95_ms" as const },
  ];
  return (
    <dl className="tr-tiles pf-tiles">
      {tiles.map((t) => (
        <div key={t.key}>
          <dt>{t.label}</dt>
          <dd>
            <span className="tr-tile__value">
              {t.key === "p95_ms" && s.requests > 0 && t.value > 0 ? (
                <a className="tr-drill" href={p95Href} title="See the requests at p95 or slower in Explore" aria-label={`p95 ${formatLatency(t.value)}: requests at p95 or slower in Explore`}>
                  <LiveNumber text={formatLatency(t.value)} />
                </a>
              ) : (
                <LiveNumber text={formatLatency(t.value)} />
              )}
            </span>
            <span className="tr-tile__sub">{t.sub}</span>
            <CompareLine comparison={compare(t.value, prev?.[t.key], { kind: "relative", better: "down", range })} />
            <Sparkline values={points.map((p) => p[t.key])} hover={{ label: t.short, range, points: points.map((p) => ({ ts: p.ts, text: formatLatency(p[t.key]) })) }} />
          </dd>
        </div>
      ))}
      <ApdexTile apdex={s.apdex} explanation={explanation} comparison={compare(s.apdex, prev?.apdex, { kind: "score", better: "up", range })} />
    </dl>
  );
}

function HistogramCard({ latency }: { latency: TrafficLatency }) {
  const buckets = (latency.histogram ?? []).map((b) => ({ label: latencyBucketLabel(b), count: b.count }));
  return (
    <Histogram
      label="Response time histogram"
      summary={`${formatCount(latency.summary.requests)} requests by response time, from ${buckets[0]?.label ?? "0 ms"} to ${buckets[buckets.length - 1]?.label ?? ""}.`}
      buckets={buckets}
      unit="count"
    />
  );
}

/** The slowest requests of the scope (#1001), slowest first, each opening in Explore. */
function SlowestTable({
  project,
  q,
  scope,
  requests,
  apps,
  now,
  tz,
}: {
  project: string;
  q: PerformanceState;
  /** The scope in words, for the empty state. */
  scope: string;
  requests: RequestRow[];
  /** The project's apps when the table shows the App column (#976); null leaves it out. */
  apps: NamedApp[] | null;
  now: number;
  tz: string;
}) {
  if (requests.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No requests in {scope}.
      </p>
    );
  }
  return (
    <table className="tr-table" aria-label="Slowest requests">
      <thead>
        <tr>
          <th scope="col">Request</th>
          {apps ? <th scope="col">App</th> : null}
          <th scope="col">Status</th>
          <th scope="col">Time</th>
          <th scope="col" className="tr-num" aria-sort="descending">
            Response time
          </th>
        </tr>
      </thead>
      <tbody>
        {requests.map((r, i) => {
          const at = logTime(r.timestamp, now, tz);
          return (
            <tr key={r.id || `${r.timestamp} ${r.trace_id} ${i}`} className="tr-row">
              <td className="tr-ep" data-label="Request">
                <a className="tr-ep__link" href={slowRequestHref(project, r, q)} title={`${r.method.toUpperCase()} ${r.path}`}>
                  <b>{r.method.toUpperCase()}</b> <code>{r.raw_path || r.path}</code>
                </a>
              </td>
              {apps ? (
                <td className="tr-app" data-label="App">
                  {appName(apps, r.app_id ?? "")}
                </td>
              ) : null}
              <td data-label="Status">
                <span className={`pf-status pf-status--${statusClass(r.status_code)}`}>{r.status_code}</span>
              </td>
              <td className="pf-when" data-label="Time">
                <time dateTime={r.timestamp}>{`${at.day ? `${at.day}, ` : ""}${at.clock} ${zoneLabel(tz, Date.parse(r.timestamp))}`}</time>
              </td>
              <td className="tr-num" data-label="Response time">
                {formatLatency(r.response_time_ms)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Endpoints by time spent (#1001): requests × average, most first, with their share of the total. */
function TimeSpentTable({
  project,
  q,
  scope,
  endpoints,
  apps,
}: {
  project: string;
  q: PerformanceState;
  /** The scope in words, for the empty state. */
  scope: string;
  endpoints: EndpointTraffic[];
  /** The project's apps when the table shows the App column (#976); null leaves it out. */
  apps: NamedApp[] | null;
}) {
  const rows = byTimeSpent(endpoints);
  if (rows.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No endpoints with requests in {scope}.
      </p>
    );
  }
  return (
    <table className="tr-table" aria-label="Endpoints by time spent">
      <caption className="pf-caption">Requests × average response time: the endpoints worth making faster first.</caption>
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          {apps ? <th scope="col">App</th> : null}
          <th scope="col" className="tr-num">
            Requests
          </th>
          <th scope="col" className="tr-num">
            Average
          </th>
          <th scope="col" className="tr-num" aria-sort="descending">
            Time spent
          </th>
          <th scope="col" className="tr-num">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ endpoint: ep, totalMs, avgMs, share }) => (
          <tr key={`${ep.app_id} ${ep.method} ${ep.path}`} className="tr-row">
            <td className="tr-ep" data-label="Endpoint">
              <a className="tr-ep__link" href={endpointLatencyHref(project, ep, q)}>
                <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
              </a>
            </td>
            {apps ? (
              <td className="tr-app" data-label="App">
                {appName(apps, ep.app_id)}
              </td>
            ) : null}
            <td className="tr-num" data-label="Requests">
              {formatCount(ep.requests)}
            </td>
            <td className="tr-num" data-label="Average">
              {formatLatency(avgMs)}
            </td>
            <td className="tr-num" data-label="Time spent">
              {formatTimeSpent(totalMs)}
            </td>
            <td className="tr-num" data-label="Share">
              <span className="pf-share">
                <span className="pf-share__bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} />
                </span>
                {formatPercent(share)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
