import {
  CONSUMERS_LOAD_FAILED,
  CONSUMER_LOAD_FAILED,
  CONSUMER_RANGES,
  type ConsumersQuery,
  GROUPS_LOAD_FAILED,
  type GroupSort,
  MAX_TEXT,
  RANGE_LABEL,
  bucketTimes,
  consumerLabel,
  consumersHref,
  errorsOf,
  formatCount,
  formatPerMinute,
  formatRate,
  groupHref,
} from "@/lib/consumers";
import { exploreHref } from "@/lib/explore";
import { NO_FILTERS } from "@/lib/explore-filters";
import { formatAgo } from "@/lib/first-data";
import type { ConsumerDetail, ConsumerGroupsTraffic, ConsumerRow, ConsumersList, QueryRange, RequestRow } from "@/lib/identity";
import type { SearchParams } from "@/lib/pagination";
import { endpointHref } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { Pagination } from "../pagination/pagination";
import { type Series, Sparkline, StackedBars } from "./charts";
import "./consumers.css";

export type DetailState = { kind: "ok"; consumer: ConsumerDetail } | { kind: "missing" } | { kind: "error" };
/** What the page read: the consumers list, the groups roll-up or one consumer; null when the API could not answer. */
export type ConsumersData =
  | { view: "consumers"; list: ConsumersList | null }
  | { view: "groups"; groups: ConsumerGroupsTraffic | null }
  | { view: "detail"; detail: DetailState };

type Unique = "returning" | "new";
const UNIQUE: readonly Series<Unique>[] = [
  { key: "returning", label: "Returning", className: "cs-fill-returning" },
  { key: "new", label: "New", className: "cs-fill-new" },
];
type Status = "successful" | "client_errors" | "server_errors";
const REQUESTS: readonly Series<Status>[] = [
  { key: "successful", label: "Successful", className: "cs-fill-ok" },
  { key: "client_errors", label: "4xx", className: "cs-fill-4xx" },
  { key: "server_errors", label: "5xx", className: "cs-fill-5xx" },
];

/** Explore's request log narrowed to one consumer or one group, in the range. */
export function exploreConsumerHref(project: string, range: QueryRange, f: { consumer_id?: string; consumer_group?: string }): string {
  return exploreHref(project, { range, filters: { ...NO_FILTERS, consumer_id: f.consumer_id ?? "", consumer_group: f.consumer_group ?? "" } });
}

/**
 * `/<project>/consumers` (#596). The users of the project's API, as the SDK identifies them on
 * each request: unique users over time split into new and returning, and a paged table by
 * requests, errors or last seen with a sparkline per user; or, by group, the groups the SDK
 * reports (the company or plan a user belongs to) with their traffic. A user opens a detail view:
 * their group, requests and errors over time, top endpoints and a paged list of their latest
 * requests or errors. All state is in the URL, so every view is a link. Groups are never created
 * or assigned here: they come from the SDK.
 */
export function ConsumersView({
  project,
  projectName,
  query: q,
  params,
  data,
  now,
}: {
  project: string;
  projectName: string;
  query: ConsumersQuery;
  /** The page's search params, for the pagination links. */
  params: SearchParams;
  data: ConsumersData;
  now: number;
}) {
  const inDetail = data.view === "detail";
  return (
    <div className="page cs">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Consumers</p>
        <h1 className="cp-lede">Consumers</h1>
        <p className="cs-lead">The users of your API: who is new, who keeps coming back, and each user’s requests and errors. Groups are the company or plan the SDK reports for each user.</p>
      </header>

      <div className="cs-bar">
        <nav className="cs-seg" aria-label="Show">
          <a href={consumersHref(project, { range: q.range })} aria-current={!inDetail && q.by === "consumers" && !q.group ? "page" : undefined}>
            Consumers
          </a>
          <a href={consumersHref(project, { range: q.range, by: "groups" })} aria-current={!inDetail && q.by === "groups" ? "page" : undefined}>
            Groups
          </a>
        </nav>
        <nav className="cs-seg" aria-label="Time range">
          {CONSUMER_RANGES.map((r) => (
            <a key={r} href={consumersHref(project, { ...q, range: r })} aria-current={q.range === r ? "page" : undefined} title={`Last ${RANGE_LABEL[r]}`}>
              {r}
            </a>
          ))}
        </nav>
      </div>

      {data.view === "detail" ? (
        <ConsumerPanel project={project} q={q} params={params} detail={data.detail} now={now} />
      ) : data.view === "groups" ? (
        data.groups === null ? (
          <LoadFailed text={GROUPS_LOAD_FAILED} href={consumersHref(project, q)} />
        ) : (
          <GroupsList project={project} q={q} params={params} groups={data.groups} now={now} />
        )
      ) : data.list === null ? (
        <LoadFailed text={CONSUMERS_LOAD_FAILED} href={consumersHref(project, q)} />
      ) : (
        <ConsumersList project={project} q={q} params={params} list={data.list} now={now} />
      )}
    </div>
  );
}

function LoadFailed({ text, href }: { text: string; href: string }) {
  return (
    <div className="cs-notice cs-notice--error" role="alert">
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="cs-notice" role="status">
      <ObIcon name="info" />
      <p>{children}</p>
    </div>
  );
}

/** A search box (a plain GET form, so it works before JavaScript) keeping the view, range, group and sort. */
function SearchForm({ project, q, label, placeholder }: { project: string; q: ConsumersQuery; label: string; placeholder: string }) {
  const id = `cs-search-${q.by}`;
  return (
    <form className="cs-search" role="search" method="get" action={`/${encodeURIComponent(project)}/consumers`}>
      {q.range !== "24h" ? <input type="hidden" name="range" value={q.range} /> : null}
      {q.by === "groups" ? <input type="hidden" name="by" value="groups" /> : null}
      {q.group ? <input type="hidden" name="group" value={q.group} /> : null}
      {q.sort !== "requests" ? <input type="hidden" name="sort" value={q.sort} /> : null}
      <label htmlFor={id} className="cs-sr">
        {label}
      </label>
      <span className="cs-search__box">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input id={id} name="q" type="search" defaultValue={q.q} placeholder={placeholder} maxLength={MAX_TEXT} autoComplete="off" />
      </span>
      <button type="submit" className="cs-btn">
        Search
      </button>
      {q.q ? (
        <a className="cp-link" href={consumersHref(project, { ...q, q: "" })}>
          Clear
        </a>
      ) : null}
    </form>
  );
}

/** A sortable column header: a link that orders the table by `sort` (largest or latest first). */
function SortHeader({ project, q, sort, children, num = true }: { project: string; q: ConsumersQuery; sort: GroupSort; children: string; num?: boolean }) {
  const active = q.sort === sort;
  return (
    <th scope="col" className={num ? "cs-num" : undefined} aria-sort={active ? "descending" : undefined}>
      <a className="cs-sort" href={consumersHref(project, { ...q, sort })} aria-current={active ? "true" : undefined} title={`Sort by ${children.toLowerCase()}, ${sort === "last_seen" ? "latest" : "most"} first`}>
        {children}
        <span aria-hidden="true" className="cs-sort__mark">
          {active ? "↓" : ""}
        </span>
      </a>
    </th>
  );
}

/**
 * The sort as links, for phone width, where the table's header row (and its sortable headers) is
 * hidden and rows stack into labelled lines.
 */
function SortBar({ project, q, sorts }: { project: string; q: ConsumersQuery; sorts: readonly [GroupSort, string][] }) {
  return (
    <nav className="cs-sortbar" aria-label="Sort">
      <span className="cs-muted">Sort</span>
      {sorts.map(([sort, label]) => (
        <a key={sort} className="cs-sort" href={consumersHref(project, { ...q, sort })} aria-current={q.sort === sort ? "true" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

const USER_SORTS: readonly [GroupSort, string][] = [
  ["requests", "Requests"],
  ["errors", "Errors"],
  ["last_seen", "Last seen"],
];
const GROUP_SORTS: readonly [GroupSort, string][] = [["consumers", "Users"], ...USER_SORTS];

function ConsumersList({ project, q, params, list, now }: { project: string; q: ConsumersQuery; params: SearchParams; list: ConsumersList; now: number }) {
  const consumers = list.consumers ?? [];
  const points = list.points ?? [];
  const s = list.summary;
  const times = bucketTimes(list.from, list.bucket_seconds, points.length);
  const range = RANGE_LABEL[q.range];
  const nobody = s.consumers === 0 && list.total === 0 && !q.q;

  return (
    <>
      {q.group ? <GroupHeader project={project} q={q} list={list} /> : null}

      {nobody ? (
        <Notice>
          {q.group
            ? `No user in ${q.group} called the API in the last ${range}. The group shows up here when the SDK reports it with a user’s requests.`
            : `No identified users in the last ${range}. Set the consumer on each request in the SDK (your user’s id, and a name and group if you have them) and they show up here. Anonymous requests are left out.`}
        </Notice>
      ) : (
        <>
          <section className="cs-card" aria-labelledby="cs-unique">
            <div className="cs-card__head">
              <h2 id="cs-unique">Unique users</h2>
              <dl className="cs-tiles">
                <div>
                  <dt>Users</dt>
                  <dd>{formatCount(s.consumers)}</dd>
                </div>
                <div>
                  <dt>New</dt>
                  <dd>{formatCount(s.new)}</dd>
                </div>
                <div>
                  <dt>Returning</dt>
                  <dd>{formatCount(s.returning)}</dd>
                </div>
              </dl>
            </div>
            <StackedBars
              label="Unique users over time"
              summary={`${formatCount(s.consumers)} users in the last ${range}: ${formatCount(s.new)} new, ${formatCount(s.returning)} returning.`}
              rows={points}
              series={UNIQUE}
              range={q.range}
              totalLabel="Users"
            />
            <p className="cs-note">New means first seen in that period; returning, seen before it.</p>
          </section>

          <section className="cs-card cs-card--table" aria-labelledby="cs-users">
            <div className="cs-tablehead">
              <h2 id="cs-users">
                Users <span className="cs-count">{formatCount(list.total)}</span>
              </h2>
              <SearchForm project={project} q={q} label="Search users" placeholder="Search by name or id" />
              <SortBar project={project} q={q} sorts={USER_SORTS} />
            </div>
            {consumers.length === 0 ? (
              <p className="cs-empty cs-empty--card" role="status">
                {q.q ? `No user matches “${q.q}” in the last ${range}.` : `No users on this page. The list changed since it was loaded.`}{" "}
                <a className="cp-link" href={consumersHref(project, { ...q, q: "" })}>
                  {q.q ? "Clear the search" : "Back to the first page"}
                </a>
              </p>
            ) : (
              <table className="cs-table" aria-labelledby="cs-users">
                <thead>
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col">Group</th>
                    <SortHeader project={project} q={q} sort="requests">
                      Requests
                    </SortHeader>
                    <SortHeader project={project} q={q} sort="errors">
                      Errors
                    </SortHeader>
                    <SortHeader project={project} q={q} sort="last_seen" num={false}>
                      Last seen
                    </SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {consumers.map((c) => (
                    <ConsumerTableRow key={c.consumer_id} project={project} q={q} c={c} times={times} now={now} />
                  ))}
                </tbody>
              </table>
            )}
            <Pagination pathname={`/${encodeURIComponent(project)}/consumers`} params={params} total={list.total} label="Users pages" />
          </section>
        </>
      )}
    </>
  );
}

/** The group view: one SDK group's users, with its totals, a way back and its requests in Explore. */
function GroupHeader({ project, q, list }: { project: string; q: ConsumersQuery; list: ConsumersList }) {
  const t = list.totals;
  const errors = errorsOf(t);
  return (
    <section className="cs-group" aria-labelledby="cs-group">
      <a className="cp-link cs-back" href={consumersHref(project, { range: q.range, by: "groups" })}>
        ← All groups
      </a>
      <div className="cs-panel__head">
        <div>
          <p className="cs-kicker">Group</p>
          <h2 id="cs-group">{q.group}</h2>
        </div>
        <a className="cs-btn" href={exploreConsumerHref(project, q.range, { consumer_group: q.group ?? "" })}>
          View requests in Explore
        </a>
      </div>
      <dl className="cs-tiles cs-tiles--panel">
        <div>
          <dt>Users</dt>
          <dd>{formatCount(list.summary.consumers)}</dd>
        </div>
        <div>
          <dt>Requests</dt>
          <dd>{formatCount(t.requests)}</dd>
        </div>
        <div>
          <dt>Errors</dt>
          <dd>
            {formatCount(errors)} <span className="cs-tiles__sub">{formatRate(errors, t.requests)}</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ConsumerTableRow({ project, q, c, times, now }: { project: string; q: ConsumersQuery; c: ConsumerRow; times: string[]; now: number }) {
  const label = consumerLabel(c);
  const errors = errorsOf(c);
  return (
    <tr className="cs-row">
      <td className="cs-who" data-label="User">
        <a className="cs-name" href={consumersHref(project, { range: q.range, consumer: c.consumer_id })}>
          {label}
        </a>
        <span className="cs-meta">
          {label !== c.consumer_id ? <code>{c.consumer_id}</code> : null}
          {c.new ? <span className="cs-new">New</span> : null}
        </span>
      </td>
      <td data-label="Group">
        {c.consumer_group ? (
          <a className="cs-glink" href={groupHref(project, c.consumer_group, q.range)}>
            {c.consumer_group}
          </a>
        ) : (
          <span className="cs-muted">None</span>
        )}
      </td>
      <td className="cs-num" data-label="Requests">
        <span className="cs-reqs">
          <Sparkline values={c.sparkline} times={times} range={q.range} name={label} />
          <span>{formatCount(c.requests)}</span>
        </span>
      </td>
      <td className="cs-num" data-label="Errors">
        <ErrorCount s={c} />
      </td>
      <td data-label="Last seen">
        <time dateTime={c.last_seen} title={c.last_seen}>
          {formatAgo(c.last_seen, now)}
        </time>
      </td>
    </tr>
  );
}

function ErrorCount({ s }: { s: { requests: number; client_errors: number; server_errors: number } }) {
  const errors = errorsOf(s);
  if (errors === 0) return <span className="cs-muted">0</span>;
  return (
    <span title={`${formatCount(s.client_errors)} 4xx, ${formatCount(s.server_errors)} 5xx`}>
      {formatCount(errors)} <span className="cs-muted">({formatRate(errors, s.requests)})</span>
    </span>
  );
}

function GroupsList({ project, q, params, groups, now }: { project: string; q: ConsumersQuery; params: SearchParams; groups: ConsumerGroupsTraffic; now: number }) {
  const rows = groups.groups ?? [];
  const range = RANGE_LABEL[q.range];
  if (groups.total === 0 && !q.q) {
    return (
      <Notice>
        {`No groups reported in the last ${range}. Pass a group with the consumer in the SDK (for example the company or plan each user belongs to) and groups show up here with their users and traffic.`}
      </Notice>
    );
  }
  const times = rows[0]?.sparkline ? bucketTimes(groups.from, groups.bucket_seconds, rows[0].sparkline.length) : [];
  return (
    <>
      <section className="cs-card cs-card--table" aria-labelledby="cs-groups">
        <div className="cs-tablehead">
          <h2 id="cs-groups">
            Groups <span className="cs-count">{formatCount(groups.total)}</span>
          </h2>
          <SearchForm project={project} q={q} label="Search groups" placeholder="Search groups" />
          <SortBar project={project} q={q} sorts={GROUP_SORTS} />
        </div>
        {rows.length === 0 ? (
          <p className="cs-empty cs-empty--card" role="status">
            {q.q ? `No group matches “${q.q}” in the last ${range}.` : "No groups on this page. The list changed since it was loaded."}{" "}
            <a className="cp-link" href={consumersHref(project, { ...q, q: "" })}>
              {q.q ? "Clear the search" : "Back to the first page"}
            </a>
          </p>
        ) : (
          <table className="cs-table" aria-labelledby="cs-groups">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <SortHeader project={project} q={q} sort="consumers">
                  Users
                </SortHeader>
                <SortHeader project={project} q={q} sort="requests">
                  Requests
                </SortHeader>
                <SortHeader project={project} q={q} sort="errors">
                  Errors
                </SortHeader>
                <SortHeader project={project} q={q} sort="last_seen" num={false}>
                  Last seen
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.group} className="cs-row">
                  <td className="cs-who" data-label="Group">
                    <a className="cs-name" href={groupHref(project, g.group, q.range)}>
                      {g.group}
                    </a>
                  </td>
                  <td className="cs-num" data-label="Users">
                    {formatCount(g.consumers)}
                  </td>
                  <td className="cs-num" data-label="Requests">
                    <span className="cs-reqs">
                      <Sparkline values={g.sparkline} times={times} range={q.range} name={g.group} />
                      <span>{formatCount(g.requests)}</span>
                    </span>
                  </td>
                  <td className="cs-num" data-label="Errors">
                    <ErrorCount s={g} />
                  </td>
                  <td data-label="Last seen">
                    <time dateTime={g.last_seen} title={g.last_seen}>
                      {formatAgo(g.last_seen, now)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination pathname={`/${encodeURIComponent(project)}/consumers`} params={params} total={groups.total} label="Groups pages" />
        <p className="cs-note cs-note--card">Groups are what the SDK reports with each request. A request counts for the group it was sent with; requests without a group are left out.</p>
      </section>
    </>
  );
}

function ConsumerPanel({ project, q, params, detail, now }: { project: string; q: ConsumersQuery; params: SearchParams; detail: DetailState; now: number }) {
  const back = consumersHref(project, { range: q.range });
  if (detail.kind !== "ok") {
    return (
      <section className="cs-panel" aria-label="User">
        <a className="cp-link cs-back" href={back}>
          ← All users
        </a>
        {detail.kind === "missing" ? <Notice>There’s no user with this id in this project.</Notice> : <LoadFailed text={CONSUMER_LOAD_FAILED} href={consumersHref(project, q)} />}
      </section>
    );
  }
  const c = detail.consumer;
  const label = consumerLabel(c);
  const s = c.summary;
  const errors = errorsOf(s);
  const points = c.points ?? [];
  const endpoints = c.top_endpoints ?? [];
  const errorsTab = q.tab === "errors";
  const rows = errorsTab ? (c.recent_errors ?? []) : (c.recent_requests ?? []);
  const total = errorsTab ? errors : s.requests;
  const range = RANGE_LABEL[q.range];
  const tabHref = (tab: "requests" | "errors") => consumersHref(project, { range: q.range, consumer: c.consumer_id, tab });
  return (
    <section className="cs-panel" aria-labelledby="cs-consumer">
      <a className="cp-link cs-back" href={c.consumer_group ? groupHref(project, c.consumer_group, q.range) : back}>
        {c.consumer_group ? `← ${c.consumer_group}` : "← All users"}
      </a>
      <div className="cs-panel__head">
        <div>
          <p className="cs-kicker">User</p>
          <h2 id="cs-consumer">{label}</h2>
          <p className="cs-meta">
            {label !== c.consumer_id ? <code>{c.consumer_id}</code> : null}
            <span>
              Group:{" "}
              {c.consumer_group ? (
                <a className="cs-glink" href={groupHref(project, c.consumer_group, q.range)}>
                  {c.consumer_group}
                </a>
              ) : (
                "none reported"
              )}
            </span>
            <span>
              First seen{" "}
              <time dateTime={c.first_seen} title={c.first_seen}>
                {formatAgo(c.first_seen, now)}
              </time>
            </span>
            {c.new ? <span className="cs-new">New</span> : null}
          </p>
        </div>
        <a className="cs-btn" href={exploreConsumerHref(project, q.range, { consumer_id: c.consumer_id })}>
          View requests in Explore
        </a>
      </div>

      <dl className="cs-tiles cs-tiles--panel">
        <div>
          <dt>Requests</dt>
          <dd>{formatCount(s.requests)}</dd>
        </div>
        <div>
          <dt>Errors</dt>
          <dd>
            {formatCount(errors)} <span className="cs-tiles__sub">{formatRate(errors, s.requests)}</span>
          </dd>
        </div>
        <div>
          <dt>Per minute</dt>
          <dd>{formatPerMinute(s.requests_per_minute)}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>
            <time dateTime={c.last_seen} title={c.last_seen}>
              {formatAgo(c.last_seen, now)}
            </time>
          </dd>
        </div>
      </dl>

      <section className="cs-card" aria-labelledby="cs-over-time">
        <div className="cs-card__head">
          <h3 id="cs-over-time">Requests over time</h3>
        </div>
        <StackedBars
          label="Requests over time"
          summary={`${formatCount(s.requests)} requests in the last ${range}: ${formatCount(s.successful)} successful, ${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx.`}
          rows={points}
          series={REQUESTS}
          range={q.range}
          totalLabel="Requests"
        />
      </section>

      <section className="cs-card cs-card--table" aria-labelledby="cs-endpoints">
        <div className="cs-tablehead">
          <h3 id="cs-endpoints">Top endpoints</h3>
        </div>
        {endpoints.length === 0 ? (
          <p className="cs-empty cs-empty--card" role="status">
            No requests in the last {range}.
          </p>
        ) : (
          <table className="cs-table" aria-labelledby="cs-endpoints">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col" className="cs-num">
                  Requests
                </th>
                <th scope="col" className="cs-num">
                  Errors
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={`${e.method} ${e.path}`} className="cs-row">
                  <td className="cs-who cs-req" data-label="Endpoint">
                    <a className="cs-name" href={endpointHref(project, e, { range: q.range })}>
                      <b>{e.method}</b> <code>{e.path}</code>
                    </a>
                  </td>
                  <td className="cs-num" data-label="Requests">
                    {formatCount(e.requests)}
                  </td>
                  <td className="cs-num" data-label="Errors">
                    <ErrorCount s={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <nav className="cs-tabs" aria-label="Latest requests">
        <a href={tabHref("requests")} aria-current={!errorsTab ? "page" : undefined}>
          Requests <span className="cs-count">{formatCount(s.requests)}</span>
        </a>
        <a href={tabHref("errors")} aria-current={errorsTab ? "page" : undefined}>
          Errors <span className="cs-count">{formatCount(errors)}</span>
        </a>
      </nav>
      <div className="cs-card cs-card--table cs-card--tab">
        {rows.length === 0 ? (
          <p className="cs-empty cs-empty--card" role="status">
            {total === 0 ? (errorsTab ? `No errors in the last ${range}.` : `No requests in the last ${range}.`) : "Nothing on this page. The list changed since it was loaded."}
          </p>
        ) : (
          <RecentTable rows={rows} label={errorsTab ? "Latest errors" : "Latest requests"} now={now} />
        )}
        <Pagination pathname={`/${encodeURIComponent(project)}/consumers`} params={params} total={total} label={errorsTab ? "Latest errors pages" : "Latest requests pages"} />
      </div>
    </section>
  );
}

function RecentTable({ rows, label, now }: { rows: RequestRow[]; label: string; now: number }) {
  return (
    <table className="cs-table cs-table--recent" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Request</th>
          <th scope="col" className="cs-num">
            Status
          </th>
          <th scope="col" className="cs-num">
            Duration
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id || `${r.timestamp}-${r.trace_id}-${i}`} className="cs-row">
            <td data-label="Time">
              <time dateTime={r.timestamp} title={r.timestamp}>
                {formatAgo(r.timestamp, now)}
              </time>
            </td>
            <td data-label="Request" className="cs-req">
              <b>{r.method}</b> <code title={r.raw_path || r.path}>{r.raw_path || r.path}</code>
            </td>
            <td className="cs-num" data-label="Status">
              <span className={`cs-status cs-status--${r.status_code >= 500 ? "5xx" : r.status_code >= 400 ? "4xx" : "ok"}`}>{r.status_code}</span>
            </td>
            <td className="cs-num" data-label="Duration">
              {Math.round(r.response_time_ms)} ms
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
