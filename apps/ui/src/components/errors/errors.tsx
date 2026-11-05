import type { ReactNode } from "react";
import { RANGE_LABEL, consumerLabel, formatCount, formatRate } from "@/lib/consumers";
import { endpointPageHref, formatPercent, formatShare } from "@/lib/endpoint-detail";
import {
  DETAIL_LOAD_FAILED,
  DETAIL_TABS,
  ERRORS_TABS,
  type ErrorsState,
  ISSUES_LOAD_FAILED,
  STATUSES_LOAD_FAILED,
  errorsHref,
  errorsScopeText,
  formatPerHour,
  reasonPhrase,
  statusClass,
} from "@/lib/errors";
import type { ErrorGroup, ErrorStatusDetail, ErrorStatusRow, ErrorStatuses } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { TRAFFIC_RANGES } from "@/lib/traffic";
import { StackedChart } from "../endpoint/charts";
import { ScopeSelect } from "../endpoint/filters";
import { ObIcon } from "../onboarding/ob";
import { ErrorModal, MarkExpected } from "./modal";
import "../traffic/traffic.css";
import "./errors.css";

/** The open tab and what its read answered: null when the API could not answer. */
export type TabLoad = { tab: "status"; data: ErrorStatuses | null } | { tab: "issues"; data: ErrorGroup[] | null };

/** The status code whose modal is open and its detail (null when the API could not answer). */
export interface DetailLoad {
  code: number;
  data: ErrorStatusDetail | null;
}

/**
 * `/<project>/errors` (#594). The project's error responses in a range and environment: the
 * Status codes tab shows 4xx and 5xx over time and every error status code by count, each opening
 * its detail in a modal (summary and frequency, consumers, and per-endpoint details pointing at
 * validation errors and exceptions, where a status code can be marked as expected); the Issues tab
 * lists failed requests by endpoint and status. Expected status codes of an endpoint are not
 * errors here or on any other dashboard. Everything is in the URL, so every view is a link.
 */
export function ErrorsView({
  project,
  projectName,
  environments,
  query: q,
  tab,
  detail,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: ErrorsState;
  tab: TabLoad;
  detail: DetailLoad | undefined;
}) {
  const href = (patch: Partial<ErrorsState>) => errorsHref(project, { ...q, code: null, ...patch });
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  return (
    <div className="tr er">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Errors</p>
        <h1 className="cp-lede">Errors</h1>
        <p className="tr-lead">Client and server error responses of your API by status code. Status codes you mark as expected for an endpoint stop counting as errors.</p>
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
        </div>
      </div>

      <nav className="cp-tabs er-tabs" aria-label="Error views">
        {ERRORS_TABS.map((t) => (
          <a key={t.slug} href={href({ tab: t.slug })} className={q.tab === t.slug ? "on" : undefined} aria-current={q.tab === t.slug ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>

      {tab.tab === "status" ? <StatusTab project={project} q={q} data={tab.data} /> : <IssuesTab project={project} q={q} data={tab.data} />}

      {detail ? (
        <ErrorModal
          title={`${detail.code} ${reasonPhrase(detail.code)}`.trim()}
          lead={`Responses with status ${detail.code} counted as errors in ${errorsScopeText(q)}.`}
          closeHref={href({})}
        >
          <Detail project={project} q={q} load={detail} />
        </ErrorModal>
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

function Tiles({ tiles }: { tiles: { label: string; value: string; sub: string }[] }) {
  return (
    <dl className="tr-tiles er-tiles">
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

const Status = ({ code }: { code: number }) => <span className={`er-status er-status--${statusClass(code)}`}>{code}</span>;

const EndpointName = ({ method, path }: { method: string; path: string }) => (
  <>
    <b>{method.toUpperCase()}</b> <code>{path}</code>
  </>
);

// Status codes ------------------------------------------------------------------------------

function StatusTab({ project, q, data }: { project: string; q: ErrorsState; data: ErrorStatuses | null }) {
  if (data === null) return <LoadFailed text={STATUSES_LOAD_FAILED} href={errorsHref(project, q)} />;
  const s = data.summary;
  if (s.requests === 0) {
    return (
      <div className="tr-notice" role="status">
        <ObIcon name="info" />
        <p>No requests in {errorsScopeText(q)}. Once your app reports requests through the SDK, their errors show up here.</p>
      </div>
    );
  }
  const statuses = data.statuses ?? [];
  const rows = (data.points ?? []).map((p) => ({ ts: p.ts, client: p.client_errors, server: p.server_errors }));
  return (
    <>
      <Tiles
        tiles={[
          { label: "Requests", value: formatCount(s.requests), sub: `in ${errorsScopeText(q)}` },
          { label: "Error rate", value: formatRate(s.client_errors + s.server_errors, s.requests), sub: `${formatCount(s.client_errors + s.server_errors)} errors` },
          { label: "Client errors (4xx)", value: formatCount(s.client_errors), sub: `${formatPercent(s.client_error_rate * 100)} of requests` },
          { label: "Server errors (5xx)", value: formatCount(s.server_errors), sub: `${formatPercent(s.server_error_rate * 100)} of requests` },
        ]}
      />
      <Card id="er-time" title="Errors over time">
        <StackedChart
          label="Errors by status class"
          summary={`${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx responses in ${errorsScopeText(q)}.`}
          rows={rows}
          series={[
            { key: "client", label: "4xx", className: "er-c-4xx" },
            { key: "server", label: "5xx", className: "er-c-5xx" },
          ]}
          unit="count"
          range={q.range}
        />
      </Card>
      <Card id="er-statuses" title="Error status codes" table>
        {statuses.length === 0 ? (
          <Empty>No error responses in {errorsScopeText(q)}.</Empty>
        ) : (
          <StatusTable project={project} q={q} statuses={statuses} />
        )}
      </Card>
    </>
  );
}

function StatusTable({ project, q, statuses }: { project: string; q: ErrorsState; statuses: ErrorStatusRow[] }) {
  return (
    <table className="tr-table" aria-label="Error status codes">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col" className="tr-num">
            Responses
          </th>
          <th scope="col" className="tr-num">
            Share of requests
          </th>
          <th scope="col" className="tr-num">
            Endpoints
          </th>
          <th scope="col" className="tr-num">
            Consumers
          </th>
          <th scope="col">Last seen</th>
        </tr>
      </thead>
      <tbody>
        {statuses.map((r) => (
          <tr key={r.status_code} className="tr-row">
            <td className="tr-ep" data-label="Status">
              <a className="tr-ep__link er-code-link" href={errorsHref(project, { ...q, code: r.status_code, view: "summary" })} aria-haspopup="dialog">
                <Status code={r.status_code} /> <span>{reasonPhrase(r.status_code) || `Status ${r.status_code}`}</span>
              </a>
            </td>
            <td className="tr-num" data-label="Responses">
              {formatCount(r.count)}
            </td>
            <td className="tr-num" data-label="Share of requests">
              {formatShare(r.share)}
            </td>
            <td className="tr-num" data-label="Endpoints">
              {formatCount(r.endpoints)}
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
  );
}

// Detail modal ------------------------------------------------------------------------------

function Detail({ project, q, load }: { project: string; q: ErrorsState; load: DetailLoad }) {
  const here = errorsHref(project, { ...q, code: load.code });
  if (load.data === null) return <LoadFailed text={DETAIL_LOAD_FAILED} href={here} />;
  const d = load.data;
  return (
    <>
      <nav className="cp-tabs er-dtabs" aria-label={`Status ${d.status_code} views`}>
        {DETAIL_TABS.map((t) => (
          <a
            key={t.slug}
            href={errorsHref(project, { ...q, code: d.status_code, view: t.slug })}
            className={q.view === t.slug ? "on" : undefined}
            aria-current={q.view === t.slug ? "page" : undefined}
          >
            {t.label}
          </a>
        ))}
      </nav>
      <div className="er-dpanel" data-view={q.view}>
        {d.occurrences === 0 ? (
          <Empty>
            No {d.status_code} responses counted as errors in {errorsScopeText(q)}. Endpoints where {d.status_code} is expected are not counted.
          </Empty>
        ) : q.view === "consumers" ? (
          <ConsumersView d={d} />
        ) : q.view === "details" ? (
          <DetailsView project={project} q={q} d={d} />
        ) : (
          <SummaryView q={q} d={d} />
        )}
      </div>
    </>
  );
}

function SummaryView({ q, d }: { q: ErrorsState; d: ErrorStatusDetail }) {
  const identified = d.occurrences - d.anonymous;
  return (
    <>
      <Tiles
        tiles={[
          { label: "Responses", value: formatCount(d.occurrences), sub: `${formatShare(d.share)} of requests` },
          { label: "Frequency", value: `${formatPerHour(d.per_hour)}/h`, sub: `over ${RANGE_LABEL[q.range]}` },
          { label: "Affected consumers", value: formatCount(d.consumers), sub: `${formatCount(identified)} responses to identified consumers` },
          { label: "Endpoints", value: formatCount(d.endpoints), sub: `answered with ${d.status_code}` },
        ]}
      />
      <dl className="er-seen">
        <div>
          <dt>First seen</dt>
          <dd>{d.first_seen ? <When iso={d.first_seen} /> : "Not in this range"}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{d.last_seen ? <When iso={d.last_seen} /> : "Not in this range"}</dd>
        </div>
      </dl>
      <section className="er-freq" aria-labelledby="er-freq">
        <h3 id="er-freq">Frequency</h3>
        <StackedChart
          label={`${d.status_code} responses over time`}
          summary={`${formatCount(d.occurrences)} responses in ${errorsScopeText(q)}, ${formatPerHour(d.per_hour)} per hour.`}
          rows={(d.points ?? []).map((p) => ({ ts: p.ts, count: p.count }))}
          series={[{ key: "count", label: `${d.status_code} responses`, className: `er-c-${statusClass(d.status_code)}` }]}
          unit="count"
          range={q.range}
        />
      </section>
    </>
  );
}

function ConsumersView({ d }: { d: ErrorStatusDetail }) {
  const consumers = d.consumer_breakdown ?? [];
  return (
    <>
      {d.anonymous ? (
        <p className="er-note">
          {formatCount(d.anonymous)} of {formatCount(d.occurrences)} responses came from requests without a consumer and are not listed.
        </p>
      ) : null}
      {consumers.length === 0 ? (
        <Empty>No identified consumers got {d.status_code} responses.</Empty>
      ) : (
        <table className="tr-table er-table" aria-label="Consumer breakdown">
          <thead>
            <tr>
              <th scope="col">Consumer</th>
              <th scope="col" className="tr-num">
                Responses
              </th>
              <th scope="col" className="tr-num">
                Share
              </th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {consumers.map((c) => (
              <tr key={c.consumer_id}>
                <td data-label="Consumer">{consumerLabel(c)}</td>
                <td className="tr-num" data-label="Responses">
                  {formatCount(c.count)}
                </td>
                <td className="tr-num" data-label="Share">
                  {formatShare(c.share)}
                </td>
                <td data-label="Last seen">
                  <When iso={c.last_seen} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function DetailsView({ project, q, d }: { project: string; q: ErrorsState; d: ErrorStatusDetail }) {
  const endpoints = d.endpoint_breakdown ?? [];
  if (endpoints.length === 0) return <Empty>No endpoints answered with {d.status_code} in {errorsScopeText(q)}.</Empty>;
  return (
    <ul className="er-eps" aria-label="Endpoints">
      {endpoints.map((e) => (
        <li key={`${e.method} ${e.path}`} className="er-ep">
          <div className="er-ep__head">
            <p className="er-ep__name">
              <EndpointName method={e.method} path={e.path} />
            </p>
            <a className="cp-link" href={endpointPageHref(project, { method: e.method.toUpperCase(), path: e.path }, { tab: "errors", range: q.range, env: q.env })}>
              Endpoint errors
            </a>
          </div>
          <p className="er-ep__facts">
            {formatCount(e.count)} {e.count === 1 ? "response" : "responses"}, {formatCount(e.consumers)} {e.consumers === 1 ? "consumer" : "consumers"}, last <When iso={e.last_seen} />
          </p>
          <p className="er-ep__facts">
            {e.validation_errors ? `${formatCount(e.validation_errors)} with validation errors` : "No validation errors"}
            {", "}
            {e.exceptions ? `${formatCount(e.exceptions)} server exceptions` : "no server exceptions"}
          </p>
          <MarkExpected project={project} method={e.method.toUpperCase()} path={e.path} code={d.status_code} />
        </li>
      ))}
    </ul>
  );
}

// Issues ------------------------------------------------------------------------------------

function IssuesTab({ project, q, data }: { project: string; q: ErrorsState; data: ErrorGroup[] | null }) {
  if (data === null) return <LoadFailed text={ISSUES_LOAD_FAILED} href={errorsHref(project, q)} />;
  return (
    <Card id="er-issues" title="Failed requests by endpoint and status" table>
      {data.length === 0 ? (
        <Empty>No failed requests in {errorsScopeText(q)}.</Empty>
      ) : (
        <table className="tr-table" aria-label="Issues">
          <thead>
            <tr>
              <th scope="col">Endpoint</th>
              <th scope="col">Status</th>
              <th scope="col" className="tr-num">
                Responses
              </th>
              <th scope="col" className="tr-num">
                Consumers
              </th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.map((g) => (
              <tr key={`${g.method} ${g.path} ${g.status_code}`} className="tr-row">
                <td className="tr-ep" data-label="Endpoint">
                  <a className="tr-ep__link" href={endpointPageHref(project, { method: g.method.toUpperCase(), path: g.path }, { tab: "errors", range: q.range, env: q.env })}>
                    <EndpointName method={g.method} path={g.path} />
                  </a>
                </td>
                <td data-label="Status">
                  <Status code={g.status_code} />
                </td>
                <td className="tr-num" data-label="Responses">
                  {formatCount(g.count)}
                </td>
                <td className="tr-num" data-label="Consumers">
                  {formatCount(g.consumers)}
                </td>
                <td data-label="Last seen">
                  <When iso={g.last_seen} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
