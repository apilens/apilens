import Link from "next/link";
import type { ReactNode } from "react";
import type { ConsumerSdk } from "@/lib/consumer-setup";
import {
  CONSUMERS_LOAD_FAILED,
  CONSUMER_LOAD_FAILED,
  type ConsumersQuery,
  type ConsumerSort,
  RANGE_LABEL,
  consumerLabel,
  consumersHref,
  errorsOf,
  formatCount,
  formatPerMinute,
} from "@/lib/consumers";
import { exploreHrefFor } from "@/lib/explore";
import { formatAgo } from "@/lib/first-data";
import { formatPercent, ratio } from "@/lib/format";
import type { AnonymousCallers, ConsumerDetail, ConsumerGroupTraffic, ConsumerRow, ConsumersList, NamedApp, QueryRange } from "@/lib/identity";
import type { SearchParams } from "@/lib/pagination";
import { endpointHref, trafficHref } from "@/lib/traffic";
import { Pagination } from "../pagination/pagination";
import { ErrorState } from "../states";
import { LiveNumber } from "../traffic/live";
import { IdentifyConsumers } from "./identify-consumers";
import { ConsumersToolbar } from "./toolbar";
import { UniqueChart } from "./unique-chart";
import "../explore/explore.css";
import "../traffic/traffic.css";
import "./consumers.css";

export type DetailState = { kind: "ok"; consumer: ConsumerDetail } | { kind: "missing" } | { kind: "error" };

/** A filter-bar value with its requests. */
export type FacetOption = { value: string; label: string; count: number };

/**
 * What the page read (null where the API could not answer): the consumers list (the rows, the
 * chart and the stats), the anonymous requests' total, the groups (sidebar and filter bar), the
 * project's apps and the methods and routes with requests (filter bar), the open user's detail,
 * and the SDKs to identify users with when none is identified yet.
 */
export interface ConsumersData {
  list: ConsumersList | null;
  anonymous: AnonymousCallers | null;
  groupFacet: ConsumerGroupTraffic[] | null;
  /** The filter bar's App, Method and Endpoint values. */
  apps: NamedApp[];
  methods: FacetOption[];
  paths: FacetOption[];
  /** Requests per status code (the sidebar's Level and Status, the bar's Status). */
  statuses: FacetOption[];
  detail?: DetailState;
  sdks: ConsumerSdk[] | null;
}

/**
 * `/project/<project>/consumers` (#596), Option B of the design: Traffic's frame (the sidebar,
 * the filter bar, the chart pinned under the toolbar, the stats strip, a table that scrolls on its
 * own) over the users the SDK identifies. The Consumers tab lists one row per username, its group
 * beside it and a New mark when the app reported it for the first time in the range; Groups rolls
 * them up by the group the SDK reports; Anonymous lists the requests without a user. A username
 * opens its drawer over the list. All state is in the URL, so every view is a link.
 */
export function ConsumersView({
  project,
  query: q,
  params,
  data,
  now,
  environments,
}: {
  project: string;
  query: ConsumersQuery;
  params: SearchParams;
  data: ConsumersData;
  now: number;
  environments: readonly string[];
}) {
  const list = data.list;
  const scope = `the last ${RANGE_LABEL[q.range]}${q.env ? ` in ${q.env}` : ""}`;
  return (
    <div className="page tr cs">
      <ConsumersToolbar
        project={project}
        query={q}
        users={(list?.consumers ?? []).map((c) => ({ id: c.consumer_id, label: consumerLabel(c), group: c.consumer_group }))}
        values={{
          group: (data.groupFacet ?? []).map((g) => ({ value: g.group, label: g.group, detail: `${formatCount(g.consumers)} ${g.consumers === 1 ? "user" : "users"}` })),
          env: environments.map((e) => ({ value: e, label: e })),
          app: data.apps.map((a) => ({ value: a.id.toLowerCase(), label: a.name })),
          method: data.methods,
          path: data.paths,
          status: [
            { value: "2xx,3xx", label: "2xx–3xx (success)" },
            { value: "4xx", label: "4xx (warning)" },
            { value: "5xx", label: "5xx (error)" },
            ...data.statuses.map((c) => ({ value: c.value, label: c.value, count: c.count })),
          ],
        }}
      />
      {list === null ? (
        <ErrorState text={CONSUMERS_LOAD_FAILED} href={consumersHref(project, q)} />
      ) : (
        <>
          <section className="tr-over" aria-label="Users over time">
            <UniqueChart points={list.points ?? []} />
            <Stats list={list} anonymous={data.anonymous} />
          </section>
          {data.sdks ? (
            <div className="cs-setup">
              <p>No users identified in {scope}. Tell the SDK who makes each request and they show up here, with their group.</p>
              <IdentifyConsumers sdks={data.sdks} />
            </div>
          ) : null}
          <section className="tr-sec tr-sec--table" aria-label="Consumers">
            <UsersTable project={project} q={q} params={params} list={list} now={now} scope={scope} />
          </section>
        </>
      )}
      {q.consumer ? <Drawer project={project} q={q} detail={data.detail ?? { kind: "error" }} now={now} /> : null}
    </div>
  );
}

/** The stats strip (Traffic's): users, new and returning (with the chart's colour keys), requests, errors, anonymous requests. */
function Stats({ list, anonymous }: { list: ConsumersList; anonymous: AnonymousCallers | null }) {
  const s = list.summary;
  const t = list.totals;
  return (
    <dl className="tr-strip">
      <div className="tr-strip__item">
        <dt>Users</dt>
        <dd>
          <LiveNumber text={formatCount(s.consumers)} />
          <span className="tr-strip__aside">unique</span>
        </dd>
      </div>
      <div className="tr-strip__item">
        <dt>
          <span className="cs-key cs-key--new" aria-hidden="true" /> New
        </dt>
        <dd>
          <LiveNumber text={formatCount(s.new)} />
          <span className="tr-strip__aside">first seen</span>
        </dd>
      </div>
      <div className="tr-strip__item">
        <dt>
          <span className="cs-key cs-key--returning" aria-hidden="true" /> Returning
        </dt>
        <dd>
          <LiveNumber text={formatCount(s.returning)} />
          <span className="tr-strip__aside">{s.consumers ? `${formatPercent(ratio(s.returning, s.consumers))} of users` : "–"}</span>
        </dd>
      </div>
      <div className="tr-strip__item">
        <dt>Requests</dt>
        <dd>
          <LiveNumber text={formatCount(t.requests)} />
          <span className="tr-strip__aside tr-strip__split">
            <span className="tr-4xx">{formatCount(t.client_errors)} 4xx</span>
            <span className="tr-5xx">{formatCount(t.server_errors)} 5xx</span>
          </span>
        </dd>
      </div>
      <div className="tr-strip__item">
        <dt>Anonymous</dt>
        <dd>
          <LiveNumber text={anonymous ? formatCount(anonymous.totals.requests) : "–"} />
          <span className="tr-strip__aside">requests, no user</span>
        </dd>
      </div>
    </dl>
  );
}

function SortHeader({ project, q, sort, label, num = true }: { project: string; q: ConsumersQuery; sort: ConsumerSort; label: string; num?: boolean }) {
  const on = q.sort === sort;
  return (
    <th scope="col" className={num ? "tr-num" : undefined} aria-sort={on ? "descending" : undefined}>
      <Link className="tr-sort" href={consumersHref(project, { ...q, sort, consumer: null })} scroll={false} prefetch={false} title={`Sort by ${label.toLowerCase()}, ${sort === "last_seen" ? "latest" : "most"} first`}>
        {label}
      </Link>
    </th>
  );
}

function Split({ n, requests }: { n: number; requests: number }) {
  if (n <= 0) return <span className="tr-muted">0</span>;
  return (
    <>
      {formatCount(n)} <span className="tr-muted">({formatPercent(ratio(n, requests))})</span>
    </>
  );
}

/** The list: one row per username, its group beside it; the row opens the user's drawer. */
function UsersTable({ project, q, params, list, now, scope }: { project: string; q: ConsumersQuery; params: SearchParams; list: ConsumersList; now: number; scope: string }) {
  const rows = list.consumers ?? [];
  if (rows.length === 0) {
    return (
      <p className="tr-empty" role="status">
        {q.q ? <>No usernames match “{q.q}” in {scope}.</> : q.group ? <>No users in {q.group} in {scope}.</> : <>No users identified in {scope}.</>}
      </p>
    );
  }
  return (
    <div className="tr-tablewrap">
      <div className="tr-scroll">
        <table className="tr-table cs-table" aria-label="Consumers">
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Group</th>
              <SortHeader project={project} q={q} sort="requests" label="Requests" />
              <SortHeader project={project} q={q} sort="errors" label="4xx" />
              <th scope="col" className="tr-num">
                5xx
              </th>
              <SortHeader project={project} q={q} sort="last_seen" label="Last seen" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <UserRow key={c.consumer_id} project={project} q={q} c={c} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      <Pagination pathname={consumersHref(project, {})} params={params} total={list.total} label="Consumers pages" always className="tr-pg" />
    </div>
  );
}

function UserRow({ project, q, c, now }: { project: string; q: ConsumersQuery; c: ConsumerRow; now: number }) {
  const label = consumerLabel(c);
  const open = q.consumer === c.consumer_id;
  return (
    <tr className={`tr-row${open ? " is-open" : ""}`}>
      <td className="tr-ep cs-user">
        <span className="tr-cell">
          <Link className="tr-ep__link cs-user__link" href={consumersHref(project, { ...q, consumer: c.consumer_id })} scroll={false} prefetch={false} aria-current={open ? "true" : undefined}>
            <code>{label}</code>
            {c.consumer_name.trim() && c.consumer_name.trim() !== c.consumer_id ? <span className="cs-user__id">{c.consumer_id}</span> : null}
          </Link>
          {c.new ? (
            <span className="cs-new" title={`First seen ${formatAgo(c.first_seen, now)}: the app reported this username for the first time in this range`}>
              New
            </span>
          ) : null}
        </span>
      </td>
      <td className="cs-group-cell">{c.consumer_group ? <span className="cs-tag">{c.consumer_group}</span> : <span className="tr-muted">—</span>}</td>
      <td className="tr-num">{formatCount(c.requests)}</td>
      <td className="tr-num">
        <Split n={c.client_errors} requests={c.requests} />
      </td>
      <td className="tr-num">
        <Split n={c.server_errors} requests={c.requests} />
      </td>
      <td className="tr-num tr-muted">{formatAgo(c.last_seen, now)}</td>
    </tr>
  );
}

/** The drawer of one user, over the list: who it is, its requests and errors, top endpoints, recent errors, and where to go next. */
function Drawer({ project, q, detail, now }: { project: string; q: ConsumersQuery; detail: DetailState; now: number }) {
  const close = consumersHref(project, { ...q, consumer: null });
  return (
    <aside className="cs-drawer" aria-label="User details">
      {detail.kind !== "ok" ? (
        <>
          <DrawerHead close={close}>
            <span className="cs-drawer__title">{q.consumer}</span>
          </DrawerHead>
          <div className="cs-drawer__body">
            {detail.kind === "missing" ? (
              <p className="tr-fnote">No requests from {q.consumer} in the last {RANGE_LABEL[q.range]}.</p>
            ) : (
              <ErrorState text={CONSUMER_LOAD_FAILED} href={consumersHref(project, q)} />
            )}
          </div>
        </>
      ) : (
        <DrawerBody project={project} q={q} c={detail.consumer} now={now} close={close} />
      )}
    </aside>
  );
}

function DrawerHead({ close, children }: { close: string; children: ReactNode }) {
  return (
    <div className="cs-drawer__head">
      {children}
      <Link className="cs-drawer__close" href={close} scroll={false} prefetch={false} aria-label="Close">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      </Link>
    </div>
  );
}

function DrawerBody({ project, q, c, now, close }: { project: string; q: ConsumersQuery; c: ConsumerDetail; now: number; close: string }) {
  const label = consumerLabel(c);
  const s = c.summary;
  const errors = errorsOf(s);
  const points = c.points ?? [];
  const top = Math.max(1, ...points.map((p) => p.requests));
  const endpoints = c.top_endpoints ?? [];
  const recentErrors = c.recent_errors ?? [];
  return (
    <>
      <DrawerHead close={close}>
        <span className="cs-drawer__who">
          <span className="cs-drawer__title">{label}</span>
          <span className="cs-drawer__sub">
            {c.consumer_group ? c.consumer_group : "No group"}
            {label !== c.consumer_id ? <> · {c.consumer_id}</> : null}
            {c.new ? <span className="cs-new">New</span> : null}
          </span>
        </span>
      </DrawerHead>
      <div className="cs-drawer__body">
        <dl className="cs-facts">
          <div>
            <dt>Requests</dt>
            <dd>{formatCount(s.requests)}</dd>
          </div>
          <div>
            <dt>Errors</dt>
            <dd>
              {formatPercent(ratio(errors, s.requests))}{" "}
              <span className="cs-facts__split">
                <span className="tr-4xx">{formatCount(s.client_errors)} 4xx</span> · <span className="tr-5xx">{formatCount(s.server_errors)} 5xx</span>
              </span>
            </dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd className="cs-facts__small">{formatAgo(c.first_seen, now)} · created by the SDK</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd className="cs-facts__small">
              {formatAgo(c.last_seen, now)} · {formatPerMinute(s.requests_per_minute)}/min
            </dd>
          </div>
        </dl>
        {points.length ? (
          <div>
            <h3 className="cs-drawer__h">Requests and errors, last {RANGE_LABEL[q.range]}</h3>
            <div className="cs-mini" aria-hidden="true">
              {points.map((p) => (
                <span key={p.ts} className="cs-mini__bar" style={{ height: `${(p.requests / top) * 100}%` }}>
                  {p.server_errors ? <span className="cs-mini__5xx" style={{ height: `${(p.server_errors / Math.max(1, p.requests)) * 100}%` }} /> : null}
                  {p.client_errors ? <span className="cs-mini__4xx" style={{ height: `${(p.client_errors / Math.max(1, p.requests)) * 100}%` }} /> : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <h3 className="cs-drawer__h">Top endpoints</h3>
          {endpoints.length === 0 ? (
            <p className="tr-fnote">No requests in this range.</p>
          ) : (
            <ul className="cs-list">
              {endpoints.slice(0, 5).map((e) => (
                <li key={`${e.method} ${e.path}`}>
                  <a href={endpointHref(project, e, { range: q.range, env: q.env })}>
                    <span className="tr-muted">{e.method.toUpperCase()}</span> {e.path}
                  </a>
                  <span className="tr-muted">{formatCount(e.requests)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="cs-drawer__h">Recent errors</h3>
          {recentErrors.length === 0 ? (
            <p className="tr-fnote">No errors in this range.</p>
          ) : (
            <ul className="cs-list">
              {recentErrors.slice(0, 5).map((r) => (
                <li key={`${r.id ?? ""}${r.timestamp}`}>
                  <span>
                    <span className={r.status_code >= 500 ? "tr-5xx" : "tr-4xx"}>{r.status_code}</span> <span className="tr-muted">{r.method.toUpperCase()}</span> {r.raw_path || r.path}
                  </span>
                  <span className="tr-muted">{formatAgo(r.timestamp, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="cs-drawer__actions">
          <a className="ah-btn ah-btn--secondary ah-btn--sm" href={exploreHrefFor(project, { range: q.range, env: q.env, consumer_id: c.consumer_id })}>
            Open in Explore
          </a>
          <a className="ah-btn ah-btn--secondary ah-btn--sm" href={trafficHref(project, { range: q.range, env: q.env, app: "", consumer: c.consumer_id })}>
            Traffic for {label}
          </a>
          {c.consumer_group ? (
            <Link className="ah-btn ah-btn--secondary ah-btn--sm" href={consumersHref(project, { range: q.range, env: q.env, group: c.consumer_group })} scroll={false} prefetch={false}>
              Show only {c.consumer_group}
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
