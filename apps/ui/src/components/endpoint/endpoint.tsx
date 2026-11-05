import type { ReactNode } from "react";
import { RANGE_LABEL, consumerLabel, formatCount, formatPerMinute, formatRate } from "@/lib/consumers";
import {
  ENDPOINT_TABS,
  type EndpointRef,
  type EndpointState,
  STATUS_CLASSES,
  endpointPageHref,
  endpointScopeText,
  formatBytes,
  formatPercent,
  formatShare,
  latencyBucketLabel,
  sizeBucketLabel,
  tabLoadFailed,
  tabTakesStatus,
} from "@/lib/endpoint-detail";
import type { EndpointErrors, EndpointLatency, EndpointRequests, EndpointSettings, EndpointTransfer, NamedApp } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { TRAFFIC_RANGES, apdexRating, formatApdex, formatLatency, trafficHref } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { StatusChart } from "../traffic/charts";
import { Histogram, LinesChart, StackedChart } from "./charts";
import { ScopeSelect } from "./filters";
import { SettingsMenu } from "./settings";
import "../traffic/traffic.css";
import "./endpoint.css";

/** The open tab and what its read answered: null when the API could not answer. */
export type TabLoad =
  | { tab: "requests"; data: EndpointRequests | null }
  | { tab: "errors"; data: EndpointErrors | null }
  | { tab: "latency"; data: EndpointLatency | null }
  | { tab: "transfer"; data: EndpointTransfer | null };

/** The project's apps (null when the API could not answer), the app in scope and its settings for this endpoint. */
export interface SettingsLoad {
  apps: NamedApp[] | null;
  app: NamedApp | null;
  settings: EndpointSettings | null;
}

/**
 * `/<project>/endpoints/<method>/<path>` (#593). One endpoint of a project: the locked scope
 * (method, path and the app whose settings apply), a filter bar (range, environment, status class,
 * consumer) and four tabs: Requests, Errors, Response times and Data transferred. Only the open
 * tab's data is read; each tab is a link, so every view can be shared. The settings menu edits the
 * endpoint's expected status codes, latency threshold and exclusion.
 */
export function EndpointView({
  project,
  projectName,
  environments,
  endpoint: ep,
  query: q,
  tab,
  settings,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  endpoint: EndpointRef;
  query: EndpointState;
  tab: TabLoad;
  settings: SettingsLoad;
}) {
  const href = (patch: Partial<EndpointState>) => endpointPageHref(project, ep, { ...q, ...patch });
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  const saved = settings.settings;

  return (
    <div className="tr ep">
      <header className="pagehead ep-head">
        <p className="cp-h">
          {projectName} ·{" "}
          <a className="cp-link" href={trafficHref(project, { range: q.range, env: q.env })}>
            Traffic
          </a>
        </p>
        <h1 className="cp-lede ep-title">
          <span className="ep-method">{ep.method}</span> <code>{ep.path}</code>
        </h1>
        <div className="ep-scope">
          <dl className="ep-locked" aria-label="Endpoint">
            <div>
              <dt>Method</dt>
              <dd>{ep.method}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>
                <code>{ep.path}</code>
              </dd>
            </div>
            <div>
              <dt>App</dt>
              <dd>{settings.app ? settings.app.name : settings.apps === null ? "Couldn’t load apps" : "No apps yet"}</dd>
            </div>
          </dl>
          {saved?.excluded ? <span className="ah-badge ep-badge">Excluded from dashboards</span> : null}
          {settings.app && saved ? <SettingsMenu project={project} endpoint={ep} app={settings.app} settings={saved} /> : null}
        </div>
        {settings.app && !saved ? (
          <p className="ep-note" role="status">
            We couldn’t load this endpoint’s settings just now.
          </p>
        ) : null}
      </header>

      <div className="tr-bar ep-bar">
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
          {tabTakesStatus(q.tab) ? (
            <ScopeSelect
              label="Status"
              value={q.status}
              options={STATUS_CLASSES.map((s) => ({ value: s, label: s === "all" ? "All statuses" : s, href: href({ status: s }) }))}
            />
          ) : null}
          {settings.apps && settings.apps.length > 1 && settings.app ? (
            <ScopeSelect label="App" value={settings.app.slug} options={settings.apps.map((a) => ({ value: a.slug, label: a.name, href: href({ app: a.slug }) }))} />
          ) : null}
          {q.consumer ? (
            <span className="ep-chip">
              Consumer <b>{q.consumer}</b>
              <a className="cp-link" href={href({ consumer: "" })} aria-label={`Clear consumer ${q.consumer}`}>
                Clear
              </a>
            </span>
          ) : null}
        </div>
      </div>

      <nav className="cp-tabs ep-tabs" aria-label="Endpoint views">
        {ENDPOINT_TABS.map((t) => (
          <a key={t.slug} href={href({ tab: t.slug })} className={q.tab === t.slug ? "on" : undefined} aria-current={q.tab === t.slug ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>

      <section className="ep-panel" aria-label={ENDPOINT_TABS.find((t) => t.slug === q.tab)?.label} data-tab={q.tab}>
        <Panel tab={tab} project={project} endpoint={ep} q={q} settings={saved} />
      </section>
    </div>
  );
}

function Panel({ tab, project, endpoint, q, settings }: { tab: TabLoad; project: string; endpoint: EndpointRef; q: EndpointState; settings: EndpointSettings | null }) {
  const retry = endpointPageHref(project, endpoint, q);
  if (tab.data === null) return <LoadFailed text={tabLoadFailed(tab.tab)} href={retry} />;
  const requests = tab.data.summary.requests;
  if (requests === 0) {
    return (
      <div className="tr-notice" role="status">
        <ObIcon name="info" />
        <p>
          No requests to {endpoint.method} {endpoint.path} in {endpointScopeText(q)}.
        </p>
      </div>
    );
  }
  switch (tab.tab) {
    case "requests":
      return <RequestsTab data={tab.data} project={project} endpoint={endpoint} q={q} />;
    case "errors":
      return <ErrorsTab data={tab.data} q={q} settings={settings} />;
    case "latency":
      return <LatencyTab data={tab.data} q={q} settings={settings} />;
    case "transfer":
      return <TransferTab data={tab.data} q={q} />;
  }
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

function Tiles({ tiles }: { tiles: { label: string; value: string; sub: string }[] }) {
  return (
    <dl className="tr-tiles ep-tiles">
      {tiles.map((t) => (
        <div key={t.label}>
          <dt>{t.label}</dt>
          <dd>
            <span className="tr-tile__value">{t.value}</span>
            <span className="tr-tile__sub">{t.sub}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Card({ id, title, table, children }: { id: string; title: string; table?: boolean; children: ReactNode }) {
  return (
    <section className={`tr-card${table ? " tr-card--table" : ""}`} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="tr-empty" role="status">
    {children}
  </p>
);

const When = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatExact(iso)}</time>;

// Requests -------------------------------------------------------------------------------

function RequestsTab({ data, project, endpoint, q }: { data: EndpointRequests; project: string; endpoint: EndpointRef; q: EndpointState }) {
  const s = data.summary;
  const points = data.points ?? [];
  const consumers = data.consumers ?? [];
  return (
    <>
      <Tiles
        tiles={[
          { label: "Requests", value: formatCount(s.requests), sub: `${formatPerMinute(s.requests_per_minute)} per minute` },
          { label: "Successful", value: formatCount(s.successful), sub: `${formatRate(s.successful, s.requests)} of requests` },
          { label: "Client errors (4xx)", value: formatCount(s.client_errors), sub: `${formatRate(s.client_errors, s.requests)} of requests` },
          { label: "Server errors (5xx)", value: formatCount(s.server_errors), sub: `${formatRate(s.server_errors, s.requests)} of requests` },
        ]}
      />
      <Card id="ep-req-time" title="Requests over time">
        <StatusChart
          label="Requests by status"
          summary={`${formatCount(s.requests)} requests in ${endpointScopeText(q)}: ${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx.`}
          rows={points}
          range={q.range}
        />
      </Card>
      <Card id="ep-consumers" title="Top consumers" table>
        {consumers.length === 0 ? (
          <Empty>No requests from identified consumers in {endpointScopeText(q)}.</Empty>
        ) : (
          <table className="tr-table" aria-label="Top consumers">
            <thead>
              <tr>
                <th scope="col">Consumer</th>
                <th scope="col" className="tr-num">
                  Requests
                </th>
                <th scope="col" className="tr-num">
                  Successful
                </th>
                <th scope="col" className="tr-num">
                  4xx
                </th>
                <th scope="col" className="tr-num">
                  5xx
                </th>
              </tr>
            </thead>
            <tbody>
              {consumers.map((c) => (
                <tr key={c.consumer_id} className="tr-row">
                  <td className="tr-ep" data-label="Consumer">
                    <a className="tr-ep__link" href={endpointPageHref(project, endpoint, { ...q, consumer: c.consumer_id })} title={`Only requests from ${consumerLabel(c)}`}>
                      {consumerLabel(c)}
                    </a>
                  </td>
                  <td className="tr-num" data-label="Requests">
                    {formatCount(c.requests)}
                  </td>
                  <td className="tr-num" data-label="Successful">
                    {formatCount(c.successful)}
                  </td>
                  <td className="tr-num" data-label="4xx">
                    {formatCount(c.client_errors)}
                  </td>
                  <td className="tr-num" data-label="5xx">
                    {formatCount(c.server_errors)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// Errors ---------------------------------------------------------------------------------


function ErrorsTab({ data, q, settings }: { data: EndpointErrors; q: EndpointState; settings: EndpointSettings | null }) {
  const s = data.summary;
  const statuses = data.statuses ?? [];
  const validation = data.validation_errors ?? [];
  const exceptions = data.exceptions ?? [];
  const expected = settings?.expected_status_codes ?? [];
  const rows = (data.points ?? []).map((p) => ({ ts: p.ts, client: p.client_error_rate * 100, server: p.server_error_rate * 100 }));
  return (
    <>
      <Tiles
        tiles={[
          { label: "Requests", value: formatCount(s.requests), sub: `in ${endpointScopeText(q)}` },
          { label: "Client error rate", value: formatPercent(s.client_error_rate * 100), sub: `${formatCount(s.client_errors)} 4xx` },
          { label: "Server error rate", value: formatPercent(s.server_error_rate * 100), sub: `${formatCount(s.server_errors)} 5xx` },
          { label: "Expected status codes", value: expected.length ? expected.join(", ") : "None", sub: expected.length ? "not counted as errors" : "every 4xx and 5xx counts" },
        ]}
      />
      <Card id="ep-err-time" title="Error rate over time">
        <LinesChart
          label="Error rate"
          summary={`${formatPercent(s.client_error_rate * 100)} client and ${formatPercent(s.server_error_rate * 100)} server errors in ${endpointScopeText(q)}.`}
          rows={rows}
          series={[
            { key: "client", label: "4xx rate", className: "ep-c-4xx" },
            { key: "server", label: "5xx rate", className: "ep-c-5xx" },
          ]}
          unit="percent"
          range={q.range}
        />
      </Card>
      <Card id="ep-statuses" title="Error status codes" table>
        {statuses.length === 0 ? (
          <Empty>No error responses in {endpointScopeText(q)}.</Empty>
        ) : (
          <table className="tr-table" aria-label="Error status codes">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="tr-num">
                  Responses
                </th>
                <th scope="col" className="tr-num">
                  Share
                </th>
                <th scope="col" className="tr-num">
                  Consumers
                </th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((r) => (
                <tr key={r.status_code}>
                  <td data-label="Status">
                    <span className={`ep-status ep-status--${r.status_code >= 500 ? "5xx" : "4xx"}`}>{r.status_code}</span>
                  </td>
                  <td className="tr-num" data-label="Responses">
                    {formatCount(r.count)}
                  </td>
                  <td className="tr-num" data-label="Share">
                    {formatShare(r.share)}
                  </td>
                  <td className="tr-num" data-label="Consumers">
                    {formatCount(r.consumers)}
                  </td>
                  <td data-label="Last seen">
                    <When iso={r.last_seen} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card id="ep-validation" title="Validation errors" table>
        {validation.length === 0 ? (
          <Empty>No rejected fields in {endpointScopeText(q)}.</Empty>
        ) : (
          <table className="tr-table" aria-label="Validation errors">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Message</th>
                <th scope="col" className="tr-num">
                  Count
                </th>
                <th scope="col" className="tr-num">
                  Consumers
                </th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {validation.map((v) => (
                <tr key={`${v.loc} ${v.msg} ${v.type}`}>
                  <td data-label="Field">
                    <code className="ep-code">{v.loc}</code>
                  </td>
                  <td data-label="Message">
                    {v.msg} {v.type ? <span className="tr-muted">({v.type})</span> : null}
                  </td>
                  <td className="tr-num" data-label="Count">
                    {formatCount(v.count)}
                  </td>
                  <td className="tr-num" data-label="Consumers">
                    {formatCount(v.consumers)}
                  </td>
                  <td data-label="Last seen">
                    <When iso={v.last_seen} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card id="ep-exceptions" title="Server exceptions" table>
        {exceptions.length === 0 ? (
          <Empty>No exceptions reported in {endpointScopeText(q)}.</Empty>
        ) : (
          <ul className="ep-exc" aria-label="Server exceptions">
            {exceptions.map((x) => (
              <li key={`${x.exception_type} ${x.message}`}>
                <details>
                  <summary>
                    <span className="ep-exc__name">
                      <b>{x.exception_type || "Exception"}</b> <span className="ep-exc__msg">{x.message}</span>
                    </span>
                    <span className="ep-exc__meta">
                      {formatCount(x.count)} times, {formatCount(x.consumers)} consumers, last <When iso={x.last_seen} />
                    </span>
                  </summary>
                  {x.stack_trace ? <pre className="ep-stack">{x.stack_trace}</pre> : <p className="tr-empty">The SDK sent no stack trace for this exception.</p>}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// Response times -------------------------------------------------------------------------

function LatencyTab({ data, q, settings }: { data: EndpointLatency; q: EndpointState; settings: EndpointSettings | null }) {
  const s = data.summary;
  const rating = apdexRating(s.apdex);
  const threshold = settings?.latency_threshold_ms;
  const buckets = (data.histogram ?? []).map((b) => ({ label: latencyBucketLabel(b), count: b.count }));
  return (
    <>
      <Tiles
        tiles={[
          { label: "p50", value: formatLatency(s.p50_ms), sub: `average ${formatLatency(s.avg_ms)}` },
          { label: "p95", value: formatLatency(s.p95_ms), sub: `p75 ${formatLatency(s.p75_ms)}, p90 ${formatLatency(s.p90_ms)}` },
          { label: "p99", value: formatLatency(s.p99_ms), sub: `slowest ${formatLatency(s.max_ms)}` },
          {
            label: "Apdex",
            value: formatApdex(s.apdex),
            sub: `${rating ?? "No requests to score"}, target ${threshold ? formatLatency(threshold) : "app default"}`,
          },
        ]}
      />
      <Card id="ep-lat-time" title="Response time over time">
        <LinesChart
          label="Response time percentiles"
          summary={`p50 ${formatLatency(s.p50_ms)}, p75 ${formatLatency(s.p75_ms)} and p95 ${formatLatency(s.p95_ms)} in ${endpointScopeText(q)}.`}
          rows={data.points ?? []}
          series={[
            { key: "p50_ms", label: "p50", className: "ep-c-p50" },
            { key: "p75_ms", label: "p75", className: "ep-c-p75" },
            { key: "p95_ms", label: "p95", className: "ep-c-p95" },
          ]}
          unit="ms"
          range={q.range}
        />
      </Card>
      <Card id="ep-lat-hist" title="Response time distribution">
        <Histogram
          label="Response time histogram"
          summary={`${formatCount(s.requests)} requests by response time, from ${buckets[0]?.label ?? "0 ms"} to ${buckets[buckets.length - 1]?.label ?? ""}.`}
          buckets={buckets}
          unit="count"
        />
      </Card>
    </>
  );
}

// Data transferred -----------------------------------------------------------------------

function TransferTab({ data, q }: { data: EndpointTransfer; q: EndpointState }) {
  const s = data.summary;
  const req = (data.request_size_histogram ?? []).map((b) => ({ label: sizeBucketLabel(b), count: b.count }));
  const res = (data.response_size_histogram ?? []).map((b) => ({ label: sizeBucketLabel(b), count: b.count }));
  return (
    <>
      <Tiles
        tiles={[
          { label: "Requests", value: formatCount(s.requests), sub: `in ${endpointScopeText(q)}` },
          { label: "Received", value: formatBytes(s.request_bytes), sub: `${formatBytes(s.avg_request_bytes)} per request` },
          { label: "Sent", value: formatBytes(s.response_bytes), sub: `${formatBytes(s.avg_response_bytes)} per response` },
          { label: "Total", value: formatBytes(s.request_bytes + s.response_bytes), sub: "request and response bodies" },
        ]}
      />
      <Card id="ep-tx-time" title="Data transferred over time">
        <StackedChart
          label="Bytes in and out"
          summary={`${formatBytes(s.request_bytes)} received and ${formatBytes(s.response_bytes)} sent in ${endpointScopeText(q)}.`}
          rows={data.points ?? []}
          series={[
            { key: "request_bytes", label: "Received (requests)", className: "ep-c-in" },
            { key: "response_bytes", label: "Sent (responses)", className: "ep-c-out" },
          ]}
          unit="bytes"
          range={q.range}
        />
      </Card>
      <div className="ep-pair">
        <Card id="ep-tx-req" title="Request body sizes">
          <Histogram label="Request size histogram" summary={`${formatCount(s.requests)} requests by request body size.`} buckets={req} unit="count" />
        </Card>
        <Card id="ep-tx-res" title="Response body sizes">
          <Histogram label="Response size histogram" summary={`${formatCount(s.requests)} requests by response body size.`} buckets={res} unit="count" />
        </Card>
      </div>
    </>
  );
}
