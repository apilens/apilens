import type { ReactNode } from "react";
import { type Comparison, compare } from "@/lib/compare";
import { formatPercent, ratio } from "@/lib/format";
import { RANGE_LABEL, consumerLabel, formatCount } from "@/lib/consumers";
import { endpointPageHref } from "@/lib/endpoint-detail";
import { exploreHrefFor } from "@/lib/explore";
import {
  DETAIL_LOAD_FAILED,
  DETAIL_PAGING,
  DETAIL_TABS,
  ERRORS_TABS,
  type ErrorsState,
  ISSUES_LOAD_FAILED,
  STATUSES_LOAD_FAILED,
  consumerIdentificationUrl,
  errorRates,
  errorsHref,
  errorsScopeText,
  formatPerHour,
  hrefParams,
  rateTop,
  reasonPhrase,
  seenAgo,
  statusClass,
  TABLE_PAGING,
} from "@/lib/errors";
import type { ErrorGroup, ErrorStatusDetail, ErrorStatusRow, ErrorStatuses } from "@/lib/identity";
import { LINKS, extLink } from "@/lib/links";
import { type PageOptions, slicePage } from "@/lib/pagination";
import { formatExact } from "@/lib/passkey-settings";
import { TRAFFIC_RANGES } from "@/lib/traffic";
import { ScopeSelect } from "../endpoint/filters";
import { ObIcon } from "../onboarding/ob";
import { PageHeader } from "../page-header";
import { PageToolbar } from "../page-toolbar";
import { Pagination } from "../pagination/pagination";
import { RangePicker } from "../range-picker";
import { Sparkline } from "../traffic/charts";
import { CompareLine } from "../traffic/compare";
import { CountBars } from "./charts";
import { ErrorModal, MarkExpected } from "./modal";
import "../traffic/traffic.css";
import "./errors.css";
import { projectHref } from "@/lib/routes";
import { ErrorState } from "../states";

/** The open tab and what its read answered: null when the API could not answer. */
export type TabLoad = { tab: "status"; data: ErrorStatuses | null } | { tab: "issues"; data: ErrorGroup[] | null };

/** The status code whose modal is open and its detail (null when the API could not answer). */
export interface DetailLoad {
  code: number;
  data: ErrorStatusDetail | null;
}

/**
 * `/project/<project>/errors` (#594). The project's error responses in a range and environment: the
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
  tz,
  now,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: ErrorsState;
  tab: TabLoad;
  detail: DetailLoad | undefined;
  /** The user's time zone. */
  tz: string;
  /** The time relative times count back from (#1002). */
  now: number;
}) {
  const href = (patch: Partial<ErrorsState>) => errorsHref(project, { ...q, code: null, ...patch });
  // Another tab, range or environment starts the table again at its first page.
  const scopeHref = (patch: Partial<ErrorsState>) => href({ ...patch, page: 1 });
  // A shared link may name an environment the project no longer lists; keep it selectable.
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  return (
    <div className="page tr er">
      <PageHeader
        title="Errors"
        lead="Client and server error responses of your API by status code. Status codes you mark as expected for an endpoint stop counting as errors."
      />

      {/* View tabs (alternate views of the same errors), then the toolbar: the page anatomy's order. */}
      <nav className="cp-tabs er-tabs" aria-label="Error views">
        {ERRORS_TABS.map((t) => (
          <a key={t.slug} href={scopeHref({ tab: t.slug })} className={q.tab === t.slug ? "on" : undefined} aria-current={q.tab === t.slug ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>

      <PageToolbar
        range={<RangePicker options={TRAFFIC_RANGES} value={q.range} href={(r) => scopeHref({ range: r })} />}
        scope={
          <ScopeSelect
            label="Environment"
            value={q.env}
            options={[{ value: "", label: "All environments", href: scopeHref({ env: "" }) }, ...envs.map((e) => ({ value: e, label: e, href: scopeHref({ env: e }) }))]}
          />
        }
      />

      {tab.tab === "status" ? <StatusTab project={project} q={q} data={tab.data} tz={tz} now={now} /> : <IssuesTab project={project} q={q} data={tab.data} tz={tz} now={now} />}

      {detail ? (
        <ErrorModal
          title={`${detail.code} ${reasonPhrase(detail.code)}`.trim()}
          lead={`Responses with status ${detail.code} counted as errors in ${errorsScopeText(q)}.`}
          closeHref={href({})}
        >
          <Detail project={project} q={q} load={detail} tz={tz} now={now} />
        </ErrorModal>
      ) : null}
    </div>
  );
}


function Tiles({ tiles }: { tiles: { label: string; value: string; sub: string; compare?: Comparison | null; mono?: boolean }[] }) {
  return (
    <dl className="tr-tiles er-tiles">
      {tiles.map((t) => (
        <div key={t.label}>
          <dt>{t.label}</dt>
          <dd>
            <span className={`tr-tile__value${t.mono ? " er-tile-ep" : ""}`}>{t.value}</span>
            <span className="tr-tile__sub">{t.sub}</span>
            <CompareLine comparison={t.compare ?? null} />
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

/**
 * The pager under a table: `href` is the page's URL as it stands (errorsHref of the state), so
 * every page link keeps the rest of it.
 */
function Pager({ project, href, total, label, options }: { project: string; href: string; total: number; label: string; options: PageOptions }) {
  return <Pagination pathname={projectHref(project, "errors")} params={hrefParams(href)} total={total} label={label} {...options} />;
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="tr-empty" role="status">
    {children}
  </p>
);

/** A time as how long ago it was, with the exact time in the user's zone in its title (#1002). */
const When = ({ iso, tz, now }: { iso: string; tz: string; now: number }) => (
  <time dateTime={iso} title={formatExact(iso, tz)}>
    {seenAgo(iso, tz, now)}
  </time>
);

/**
 * No consumer identified (#1002): instead of a bare 0, a link to how the SDK identifies who calls.
 * `children` is the link text.
 */
const IdentifyLink = ({ children }: { children: ReactNode }) => (
  <a className="cp-link er-identify" {...extLink(consumerIdentificationUrl(LINKS.docs))}>
    {children}
  </a>
);

/** A consumer count; none identified links to consumer identification. */
const Consumers = ({ n }: { n: number }) =>
  n > 0 ? (
    <>{formatCount(n)}</>
  ) : (
    <span className="er-none" title="No identified consumer. Set the consumer on each request in the SDK to see who is affected.">
      <IdentifyLink>None identified</IdentifyLink>
    </span>
  );

const Status = ({ code }: { code: number }) => <span className={`er-status er-status--${statusClass(code)}`}>{code}</span>;

const EndpointName = ({ method, path }: { method: string; path: string }) => (
  <>
    <b>{method.toUpperCase()}</b> <code>{path}</code>
  </>
);

// Status codes ------------------------------------------------------------------------------

function StatusTab({ project, q, data, tz, now }: { project: string; q: ErrorsState; data: ErrorStatuses | null; tz: string; now: number }) {
  if (data === null) return <ErrorState text={STATUSES_LOAD_FAILED} href={errorsHref(project, q)} />;
  const s = data.summary;
  const p = data.previous;
  if (s.requests === 0) {
    return (
      <div className="tr-notice" role="status">
        <ObIcon name="info" />
        <p>No requests in {errorsScopeText(q)}. Once your app reports requests through the SDK, their errors show up here.</p>
      </div>
    );
  }
  const statuses = data.statuses ?? [];
  const points = data.points ?? [];
  const rows = points.map((p) => ({ ts: p.ts, client: p.client_errors, server: p.server_errors }));
  const rates = errorRates(points);
  const peak = Math.max(0, ...rates);
  return (
    <>
      <Tiles
        tiles={[
          {
            label: "Requests",
            value: formatCount(s.requests),
            sub: `in ${errorsScopeText(q)}`,
            compare: compare(s.requests, p?.requests, { kind: "relative", better: "neither", range: q.range }),
          },
          {
            label: "Error rate",
            value: formatPercent(ratio(s.client_errors + s.server_errors, s.requests)),
            sub: `${formatCount(s.client_errors + s.server_errors)} errors`,
            compare: p ? compare(ratio(s.client_errors + s.server_errors, s.requests), ratio(p.client_errors + p.server_errors, p.requests), { kind: "rate", better: "down", range: q.range }) : null,
          },
          {
            label: "Client errors (4xx)",
            value: formatCount(s.client_errors),
            sub: `${formatPercent(s.client_error_rate)} of requests`,
            compare: compare(s.client_error_rate, p?.client_error_rate, { kind: "rate", better: "down", range: q.range }),
          },
          {
            label: "Server errors (5xx)",
            value: formatCount(s.server_errors),
            sub: `${formatPercent(s.server_error_rate)} of requests`,
            compare: compare(s.server_error_rate, p?.server_error_rate, { kind: "rate", better: "down", range: q.range }),
          },
        ]}
      />
      <Card id="er-time" title="Errors over time">
        <CountBars
          label="Errors by status class"
          summary={`${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx responses in ${errorsScopeText(q)}; the error rate peaked at ${formatPercent(peak)}.`}
          rows={rows}
          series={[
            { key: "client", label: "4xx", className: "er-c-4xx" },
            { key: "server", label: "5xx", className: "er-c-5xx" },
          ]}
          range={q.range}
          line={{ label: "Error rate", values: rates, top: rateTop(rates) }}
        />
      </Card>
      <Card id="er-statuses" title="Error status codes" table>
        {statuses.length === 0 ? (
          <Empty>No error responses in {errorsScopeText(q)}.</Empty>
        ) : (
          <StatusTable project={project} q={q} statuses={statuses} points={points} series={data.series ?? []} tz={tz} now={now} />
        )}
      </Card>
    </>
  );
}

function StatusTable({
  project,
  q,
  statuses,
  points,
  series,
  tz,
  now,
}: {
  project: string;
  q: ErrorsState;
  statuses: ErrorStatusRow[];
  points: { ts: string }[];
  series: NonNullable<ErrorStatuses["series"]>;
  tz: string;
  now: number;
}) {
  const { rows, window } = slicePage(statuses, q);
  const counts = new Map(series.map((s) => [s.status_code, s.counts ?? []]));
  return (
    <>
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
            <th scope="col" className="er-trend-h">
              Over time
            </th>
            <th scope="col">First seen</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.status_code} className="tr-row">
              <td className="tr-ep" data-label="Status">
                <a className="tr-ep__link er-code-link" href={errorsHref(project, { ...q, code: r.status_code, view: "summary", dpage: 1 })} aria-haspopup="dialog">
                  <Status code={r.status_code} /> <span>{reasonPhrase(r.status_code) || `Status ${r.status_code}`}</span>
                </a>
              </td>
              <td className="tr-num" data-label="Responses">
                <a
                  className="tr-drill"
                  href={exploreHrefFor(project, { range: q.range, env: q.env, status: String(r.status_code) })}
                  title={`See the ${r.status_code} responses in Explore`}
                  aria-label={`${formatCount(r.count)} ${r.status_code} responses in Explore`}
                >
                  {formatCount(r.count)}
                </a>
              </td>
              <td className="tr-num" data-label="Share of requests">
                {formatPercent(r.share)}
              </td>
              {r.endpoint && r.endpoints === 1 ? (
                <td className="er-one-ep" data-label="Endpoint">
                  <span className="er-one-ep__name">
                    <EndpointName method={r.endpoint.method} path={r.endpoint.path} />
                  </span>
                </td>
              ) : (
                <td className="tr-num" data-label="Endpoints">
                  {formatCount(r.endpoints)}
                </td>
              )}
              <td className="tr-num" data-label="Consumers">
                <Consumers n={r.consumers} />
              </td>
              <td className="er-trend" data-label="Over time">
                <Trend code={r.status_code} counts={counts.get(r.status_code) ?? []} points={points} range={q.range} />
              </td>
              <td data-label="First seen">
                <When iso={r.first_seen} tz={tz} now={now} />
              </td>
              <td data-label="Last seen">
                <When iso={r.last_seen} tz={tz} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager project={project} href={errorsHref(project, q)} total={window.total} label="Error status code pages" options={TABLE_PAGING} />
    </>
  );
}

/** One status code's responses per bucket as a hoverable sparkline; nothing when the API sent no series. */
function Trend({ code, counts, points, range }: { code: number; counts: number[]; points: { ts: string }[]; range: ErrorsState["range"] }) {
  if (counts.length === 0 || counts.length !== points.length) return <span className="tr-muted">–</span>;
  return <Sparkline values={counts} hover={{ label: `${code} responses`, range, points: points.map((p, i) => ({ ts: p.ts, text: formatCount(counts[i]) })) }} />;
}

// Detail modal ------------------------------------------------------------------------------

function Detail({ project, q, load, tz, now }: { project: string; q: ErrorsState; load: DetailLoad; tz: string; now: number }) {
  const here = errorsHref(project, { ...q, code: load.code });
  if (load.data === null) return <ErrorState text={DETAIL_LOAD_FAILED} href={here} />;
  const d = load.data;
  return (
    <>
      <nav className="cp-tabs er-dtabs" aria-label={`Status ${d.status_code} views`}>
        {DETAIL_TABS.map((t) => (
          <a
            key={t.slug}
            href={errorsHref(project, { ...q, code: d.status_code, view: t.slug, dpage: 1 })}
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
          <ConsumersView project={project} q={q} d={d} tz={tz} now={now} />
        ) : q.view === "details" ? (
          <DetailsView project={project} q={q} d={d} tz={tz} now={now} />
        ) : (
          <SummaryView q={q} d={d} tz={tz} now={now} />
        )}
      </div>
    </>
  );
}

function SummaryView({ q, d, tz, now }: { q: ErrorsState; d: ErrorStatusDetail; tz: string; now: number }) {
  const identified = d.occurrences - d.anonymous;
  // The only endpoint is named instead of counted as 1 (#1002).
  const only = d.endpoints === 1 && d.endpoint_breakdown?.length === 1 ? d.endpoint_breakdown[0] : null;
  return (
    <>
      <Tiles
        tiles={[
          { label: "Responses", value: formatCount(d.occurrences), sub: `${formatPercent(d.share)} of requests` },
          { label: "Frequency", value: `${formatPerHour(d.per_hour)}/h`, sub: `over ${RANGE_LABEL[q.range]}` },
          { label: "Affected consumers", value: formatCount(d.consumers), sub: `${formatCount(identified)} responses to identified consumers` },
          only
            ? { label: "Endpoint", value: `${only.method.toUpperCase()} ${only.path}`, sub: `the only one that answered with ${d.status_code}`, mono: true }
            : { label: "Endpoints", value: formatCount(d.endpoints), sub: `answered with ${d.status_code}` },
        ]}
      />
      <dl className="er-seen">
        <div>
          <dt>First seen</dt>
          <dd>{d.first_seen ? <When iso={d.first_seen} tz={tz} now={now} /> : "Not in this range"}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{d.last_seen ? <When iso={d.last_seen} tz={tz} now={now} /> : "Not in this range"}</dd>
        </div>
      </dl>
      <section className="er-freq" aria-labelledby="er-freq">
        <h3 id="er-freq">Frequency</h3>
        <CountBars
          label={`${d.status_code} responses over time`}
          summary={`${formatCount(d.occurrences)} responses in ${errorsScopeText(q)}, ${formatPerHour(d.per_hour)} per hour.`}
          rows={(d.points ?? []).map((p) => ({ ts: p.ts, count: p.count }))}
          series={[{ key: "count", label: `${d.status_code} responses`, className: `er-c-${statusClass(d.status_code)}` }]}
          range={q.range}
        />
      </section>
    </>
  );
}

function ConsumersView({ project, q, d, tz, now }: { project: string; q: ErrorsState; d: ErrorStatusDetail; tz: string; now: number }) {
  const all = d.consumer_breakdown ?? [];
  const { rows: consumers, window } = slicePage(all, { page: q.dpage, per: q.dper });
  return (
    <>
      {d.anonymous ? (
        <p className="er-note">
          {formatCount(d.anonymous)} of {formatCount(d.occurrences)} responses came from requests without a consumer and are not listed.
        </p>
      ) : null}
      {consumers.length === 0 ? (
        <Empty>
          No identified consumers got {d.status_code} responses. Set the consumer on each request in the SDK to see who is affected.{" "}
          <IdentifyLink>How to identify consumers</IdentifyLink>
        </Empty>
      ) : (
        <>
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
                  <td className="tr-num er-share" data-label="Share">
                    <span className="er-meter" aria-hidden="true">
                      <span className={`er-c-${statusClass(d.status_code)}`} style={{ width: `${Math.min(100, Math.max(0, c.share * 100))}%` }} />
                    </span>
                    {formatPercent(c.share)}
                  </td>
                  <td data-label="Last seen">
                    <When iso={c.last_seen} tz={tz} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager project={project} href={errorsHref(project, q)} total={window.total} label="Consumer pages" options={DETAIL_PAGING} />
        </>
      )}
    </>
  );
}

function DetailsView({ project, q, d, tz, now }: { project: string; q: ErrorsState; d: ErrorStatusDetail; tz: string; now: number }) {
  const all = d.endpoint_breakdown ?? [];
  if (all.length === 0) return <Empty>No endpoints answered with {d.status_code} in {errorsScopeText(q)}.</Empty>;
  const { rows: endpoints, window } = slicePage(all, { page: q.dpage, per: q.dper });
  return (
    <>
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
              {formatCount(e.count)} {e.count === 1 ? "response" : "responses"}, {formatCount(e.consumers)} {e.consumers === 1 ? "consumer" : "consumers"}, last seen <When iso={e.last_seen} tz={tz} now={now} />
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
      <Pager project={project} href={errorsHref(project, q)} total={window.total} label="Endpoint pages" options={DETAIL_PAGING} />
    </>
  );
}

// Issues ------------------------------------------------------------------------------------

function IssuesTab({ project, q, data, tz, now }: { project: string; q: ErrorsState; data: ErrorGroup[] | null; tz: string; now: number }) {
  if (data === null) return <ErrorState text={ISSUES_LOAD_FAILED} href={errorsHref(project, q)} />;
  const { rows, window } = slicePage(data, q);
  return (
    <Card id="er-issues" title="Failed requests by endpoint and status" table>
      {data.length === 0 ? (
        <Empty>No failed requests in {errorsScopeText(q)}.</Empty>
      ) : (
        <>
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
              {rows.map((g) => (
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
                    <Consumers n={g.consumers} />
                  </td>
                  <td data-label="Last seen">
                    <When iso={g.last_seen} tz={tz} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager project={project} href={errorsHref(project, q)} total={window.total} label="Issue pages" options={TABLE_PAGING} />
        </>
      )}
    </Card>
  );
}
