import { RANGE_LABEL, formatCount } from "@/lib/consumers";
import { latencyBucketLabel } from "@/lib/endpoint-detail";
import type { AppSettings, EndpointTraffic, NamedApp, TrafficLatency } from "@/lib/identity";
import {
  PERFORMANCE_LOAD_FAILED,
  PERF_ENDPOINTS_LOAD_FAILED,
  type PerformanceState,
  apdexExplanation,
  byP95,
  endpointLatencyHref,
  perfScopeText,
  performanceHref,
} from "@/lib/performance";
import { TRAFFIC_RANGES, formatApdex, formatLatency } from "@/lib/traffic";
import { Histogram, LinesChart } from "../endpoint/charts";
import { ScopeSelect } from "../endpoint/filters";
import { ObIcon } from "../onboarding/ob";
import { Sparkline } from "../traffic/charts";
import { LiveControl, LiveNumber } from "../traffic/live";
import { ApdexTile } from "./apdex";
import { AppThresholdMenu } from "./threshold";
import "../traffic/traffic.css";
import "../endpoint/endpoint.css";
import "./performance.css";

/** The project's apps (null when the API could not answer), the app in scope and its threshold. */
export interface AppThresholdLoad {
  apps: NamedApp[] | null;
  app: NamedApp | null;
  settings: AppSettings | null;
}

/**
 * `/<project>/performance` (#595). How fast the project's API answers in a range and environment:
 * p50, p75 and p95 tiles with their trend, the Apdex with a gauge and how it is scored, the
 * response-time histogram and the endpoints by p95, each opening its Response times tab (where the
 * endpoint's own threshold is set). The app settings dialog edits the app-wide response time
 * threshold. The scope is in the URL; each read is null when the API could not answer it.
 */
export function PerformanceView({
  project,
  projectName,
  environments,
  query: q,
  latency,
  endpoints,
  threshold,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: PerformanceState;
  latency: TrafficLatency | null;
  endpoints: EndpointTraffic[] | null;
  threshold: AppThresholdLoad;
}) {
  const href = (patch: Partial<PerformanceState>) => performanceHref(project, { ...q, ...patch });
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  const { app, settings } = threshold;
  const explanation = apdexExplanation(app && settings ? { name: app.name, thresholdMs: settings.apdex_threshold_ms } : null);

  return (
    <div className="tr pf">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Performance</p>
        <h1 className="cp-lede">Performance</h1>
        <p className="tr-lead">How fast your API answers: response time percentiles, Apdex and the slowest endpoints.</p>
      </header>

      <div className="tr-bar">
        <div className="tr-bar__scope">
          <nav className="tr-seg" aria-label="Time range">
            {TRAFFIC_RANGES.map((r) => (
              <a key={r} href={href({ range: r })} aria-current={q.range === r ? "page" : undefined} title={`Last ${RANGE_LABEL[r]}`}>
                {r}
              </a>
            ))}
          </nav>
          <ScopeSelect
            label="Environment"
            value={q.env}
            options={[{ value: "", label: "All environments", href: href({ env: "" }) }, ...envs.map((e) => ({ value: e, label: e, href: href({ env: e }) }))]}
          />
          {threshold.apps && threshold.apps.length > 1 && app ? (
            <ScopeSelect label="App" value={app.slug} options={threshold.apps.map((a) => ({ value: a.slug, label: a.name, href: href({ app: a.slug }) }))} />
          ) : null}
        </div>
        <div className="pf-bar__end">
          {app && settings ? <AppThresholdMenu key={app.id} project={project} app={app} settings={settings} /> : null}
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
          <p>No requests in {perfScopeText(q)}. Once your app reports requests through the SDK, their response times show up here.</p>
        </div>
      ) : (
        <>
          <Tiles latency={latency} explanation={explanation} />
          <section className="tr-card" aria-labelledby="pf-over-time">
            <h2 id="pf-over-time">Response time over time</h2>
            <LinesChart
              label="Response time percentiles"
              summary={`p50 ${formatLatency(latency.summary.p50_ms)}, p75 ${formatLatency(latency.summary.p75_ms)} and p95 ${formatLatency(latency.summary.p95_ms)} in ${perfScopeText(q)}.`}
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
        <section className="tr-card tr-card--table" aria-labelledby="pf-endpoints">
          <h2 id="pf-endpoints">Endpoints by p95</h2>
          {endpoints === null ? (
            <LoadFailed text={PERF_ENDPOINTS_LOAD_FAILED} href={href({})} />
          ) : (
            <EndpointsTable project={project} q={q} endpoints={byP95(endpoints)} />
          )}
        </section>
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

function Tiles({ latency, explanation }: { latency: TrafficLatency; explanation: readonly string[] }) {
  const s = latency.summary;
  const points = latency.points ?? [];
  const tiles = [
    { label: "p50 response time", value: s.p50_ms, sub: `average ${formatLatency(s.avg_ms)}`, key: "p50_ms" as const },
    { label: "p75 response time", value: s.p75_ms, sub: `p90 ${formatLatency(s.p90_ms)}`, key: "p75_ms" as const },
    { label: "p95 response time", value: s.p95_ms, sub: `p99 ${formatLatency(s.p99_ms)}, slowest ${formatLatency(s.max_ms)}`, key: "p95_ms" as const },
  ];
  return (
    <dl className="tr-tiles pf-tiles">
      {tiles.map((t) => (
        <div key={t.key}>
          <dt>{t.label}</dt>
          <dd>
            <span className="tr-tile__value">
              <LiveNumber text={formatLatency(t.value)} />
            </span>
            <span className="tr-tile__sub">{t.sub}</span>
            <Sparkline values={points.map((p) => p[t.key])} />
          </dd>
        </div>
      ))}
      <ApdexTile apdex={s.apdex} explanation={explanation} />
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

function EndpointsTable({ project, q, endpoints }: { project: string; q: PerformanceState; endpoints: EndpointTraffic[] }) {
  if (endpoints.length === 0) {
    return (
      <p className="tr-empty" role="status">
        No endpoints with requests in {perfScopeText(q)}.
      </p>
    );
  }
  return (
    <table className="tr-table" aria-label="Endpoints by p95 response time">
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th scope="col" className="tr-num">
            Requests
          </th>
          <th scope="col" className="tr-num">
            p50
          </th>
          <th scope="col" className="tr-num" aria-sort="descending">
            p95
          </th>
          <th scope="col" className="tr-num">
            Apdex
          </th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((ep) => (
          <tr key={`${ep.method} ${ep.path}`} className="tr-row">
            <td className="tr-ep" data-label="Endpoint">
              <a className="tr-ep__link" href={endpointLatencyHref(project, ep, q)}>
                <b>{ep.method.toUpperCase()}</b> <code>{ep.path}</code>
              </a>
            </td>
            <td className="tr-num" data-label="Requests">
              {formatCount(ep.requests)}
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}
