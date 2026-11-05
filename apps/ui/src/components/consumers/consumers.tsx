import {
  CONSUMERS_LOAD_FAILED,
  CONSUMER_LOAD_FAILED,
  CONSUMER_RANGES,
  type ConsumersQuery,
  RANGE_LABEL,
  consumerLabel,
  consumersHref,
  errorsOf,
  formatCount,
  formatPerMinute,
  formatRate,
  rollupGroups,
} from "@/lib/consumers";
import { formatAgo } from "@/lib/first-data";
import type { ConsumerDetail, ConsumerGroup, ConsumerRow, ConsumersList, RequestRow } from "@/lib/identity";
import { ObIcon } from "../onboarding/ob";
import { type Series, Sparkline, StackedBars } from "./charts";
import { GroupPicker, GroupsManager } from "./groups";
import "./consumers.css";

export type DetailState = { kind: "ok"; consumer: ConsumerDetail } | { kind: "missing" } | { kind: "error" };

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
const ERRORS = REQUESTS.slice(1);

/**
 * `/<project>/consumers` (#596). The project's API consumers in a range: unique consumers over
 * time split into new and returning, and a table by requests with a sparkline per consumer; or,
 * by group, each consumer group's traffic and the group management. A consumer opens a detail
 * panel with two tabs, Requests and Errors, and the group it is in. All state is in the URL, so
 * every view is a link. `list` and `groups` are null when the API could not answer.
 */
export function ConsumersView({
  project,
  projectName,
  query: q,
  list,
  groups,
  detail,
  now,
}: {
  project: string;
  projectName: string;
  query: ConsumersQuery;
  list: ConsumersList | null;
  groups: ConsumerGroup[] | null;
  detail: DetailState | undefined;
  now: number;
}) {
  const filterGroup = q.group ? groups?.find((g) => g.id === q.group) : undefined;
  return (
    <div className="cs">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Consumers</p>
        <h1 className="cp-lede">Consumers</h1>
        <p className="cs-lead">Who calls your API: unique consumers, new and returning, and each consumer’s requests and errors.</p>
      </header>

      <div className="cs-bar">
        <nav className="cs-seg" aria-label="Show">
          <a href={consumersHref(project, { range: q.range })} aria-current={q.by === "consumers" && !q.consumer ? "page" : undefined}>
            Consumers
          </a>
          <a href={consumersHref(project, { range: q.range, by: "groups" })} aria-current={q.by === "groups" && !q.consumer ? "page" : undefined}>
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

      {detail ? (
        <ConsumerPanel project={project} q={q} detail={detail} groups={groups} now={now} />
      ) : list === null ? (
        <LoadFailed text={CONSUMERS_LOAD_FAILED} href={consumersHref(project, q)} />
      ) : q.by === "groups" ? (
        <GroupsManager project={project} range={q.range} groups={groups} rollups={groups ? rollupGroups(groups, list.consumers ?? []) : []} />
      ) : (
        <>
          {q.group ? (
            <p className="cs-filter">
              <span>
                Group: <b>{filterGroup?.name ?? "Unknown group"}</b>
              </span>
              <a className="cp-link" href={consumersHref(project, { range: q.range })}>
                Show all consumers
              </a>
            </p>
          ) : null}
          <ConsumersList project={project} q={q} list={list} now={now} />
        </>
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

function ConsumersList({ project, q, list, now }: { project: string; q: ConsumersQuery; list: ConsumersList; now: number }) {
  const consumers = list.consumers ?? [];
  const points = list.points ?? [];
  const s = list.summary;
  if (s.consumers === 0 && consumers.length === 0) {
    return (
      <div className="cs-notice" role="status">
        <ObIcon name="info" />
        <p>
          {q.group
            ? `No consumer of this group called the API in the last ${RANGE_LABEL[q.range]}.`
            : `No identified consumers in the last ${RANGE_LABEL[q.range]}. Set the consumer on each request in the SDK (an id, and a name if you have one) and they show up here.`}
        </p>
      </div>
    );
  }
  return (
    <>
      <section className="cs-card" aria-labelledby="cs-unique">
        <div className="cs-card__head">
          <h2 id="cs-unique">Unique consumers</h2>
          <dl className="cs-tiles">
            <div>
              <dt>Consumers</dt>
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
          label="Unique consumers over time"
          summary={`${formatCount(s.consumers)} consumers in the last ${RANGE_LABEL[q.range]}: ${formatCount(s.new)} new, ${formatCount(s.returning)} returning.`}
          rows={points}
          series={UNIQUE}
          range={q.range}
        />
        <p className="cs-note">New means first seen in that period; returning, seen before it.</p>
      </section>

      <div className="cs-card">
        <table className="cs-table" aria-label="Consumers">
          <thead>
            <tr>
              <th scope="col">Consumer</th>
              <th scope="col">Group</th>
              <th scope="col" className="cs-num">
                Requests
              </th>
              <th scope="col" className="cs-num">
                Errors
              </th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {consumers.map((c) => (
              <ConsumerTableRow key={c.consumer_id} project={project} q={q} c={c} now={now} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ConsumerTableRow({ project, q, c, now }: { project: string; q: ConsumersQuery; c: ConsumerRow; now: number }) {
  const label = consumerLabel(c);
  const errors = errorsOf(c);
  return (
    <tr className="cs-row">
      <td className="cs-who" data-label="Consumer">
        <a className="cs-name" href={consumersHref(project, { range: q.range, consumer: c.consumer_id })}>
          {label}
        </a>
        <span className="cs-meta">
          {label !== c.consumer_id ? <code>{c.consumer_id}</code> : null}
          {c.new ? <span className="cs-new">New</span> : null}
        </span>
      </td>
      <td data-label="Group">{c.group ? c.group.name : <span className="cs-muted">None</span>}</td>
      <td className="cs-num" data-label="Requests">
        <span className="cs-reqs">
          <Sparkline values={c.sparkline} />
          <span>{formatCount(c.requests)}</span>
        </span>
      </td>
      <td className="cs-num" data-label="Errors">
        {errors > 0 ? (
          <span title={`${formatCount(c.client_errors)} 4xx, ${formatCount(c.server_errors)} 5xx`}>
            {formatCount(errors)} <span className="cs-muted">({formatRate(errors, c.requests)})</span>
          </span>
        ) : (
          <span className="cs-muted">0</span>
        )}
      </td>
      <td data-label="Last seen">
        <time dateTime={c.last_seen} title={c.last_seen}>
          {formatAgo(c.last_seen, now)}
        </time>
      </td>
    </tr>
  );
}

function ConsumerPanel({ project, q, detail, groups, now }: { project: string; q: ConsumersQuery; detail: DetailState; groups: ConsumerGroup[] | null; now: number }) {
  const back = consumersHref(project, { range: q.range });
  if (detail.kind !== "ok") {
    return (
      <section className="cs-panel" aria-label="Consumer">
        <a className="cp-link cs-back" href={back}>
          ← All consumers
        </a>
        {detail.kind === "missing" ? (
          <div className="cs-notice" role="status">
            <ObIcon name="info" />
            <p>There’s no consumer with this id in this project.</p>
          </div>
        ) : (
          <LoadFailed text={CONSUMER_LOAD_FAILED} href={consumersHref(project, q)} />
        )}
      </section>
    );
  }
  const c = detail.consumer;
  const label = consumerLabel(c);
  const s = c.summary;
  const errors = errorsOf(s);
  const points = c.points ?? [];
  const rows = q.tab === "errors" ? (c.recent_errors ?? []) : (c.recent_requests ?? []);
  const tabHref = (tab: "requests" | "errors") => consumersHref(project, { range: q.range, consumer: c.consumer_id, tab });
  return (
    <section className="cs-panel" aria-labelledby="cs-consumer">
      <a className="cp-link cs-back" href={back}>
        ← All consumers
      </a>
      <div className="cs-panel__head">
        <div>
          <h2 id="cs-consumer">{label}</h2>
          <p className="cs-meta">
            {label !== c.consumer_id ? <code>{c.consumer_id}</code> : null}
            <span>
              First seen <time dateTime={c.first_seen} title={c.first_seen}>{formatAgo(c.first_seen, now)}</time>
            </span>
            <span>
              Last seen <time dateTime={c.last_seen} title={c.last_seen}>{formatAgo(c.last_seen, now)}</time>
            </span>
          </p>
        </div>
        <GroupPicker project={project} consumer={c.consumer_id} current={c.group ?? null} groups={groups} />
      </div>

      <nav className="cs-tabs" aria-label="Consumer detail">
        <a href={tabHref("requests")} aria-current={q.tab === "requests" ? "page" : undefined}>
          Requests
        </a>
        <a href={tabHref("errors")} aria-current={q.tab === "errors" ? "page" : undefined}>
          Errors
        </a>
      </nav>

      {q.tab === "requests" ? (
        <dl className="cs-tiles cs-tiles--panel">
          <div>
            <dt>Requests</dt>
            <dd>{formatCount(s.requests)}</dd>
          </div>
          <div>
            <dt>Per minute</dt>
            <dd>{formatPerMinute(s.requests_per_minute)}</dd>
          </div>
          <div>
            <dt>Error rate</dt>
            <dd>{formatRate(errors, s.requests)}</dd>
          </div>
        </dl>
      ) : (
        <dl className="cs-tiles cs-tiles--panel">
          <div>
            <dt>Errors</dt>
            <dd>{formatCount(errors)}</dd>
          </div>
          <div>
            <dt>4xx</dt>
            <dd>{formatCount(s.client_errors)}</dd>
          </div>
          <div>
            <dt>5xx</dt>
            <dd>{formatCount(s.server_errors)}</dd>
          </div>
        </dl>
      )}

      <div className="cs-card cs-card--flat">
        <StackedBars
          label={q.tab === "errors" ? "Errors over time" : "Requests over time"}
          summary={
            q.tab === "errors"
              ? `${formatCount(s.client_errors)} 4xx and ${formatCount(s.server_errors)} 5xx in the last ${RANGE_LABEL[q.range]}.`
              : `${formatCount(s.requests)} requests in the last ${RANGE_LABEL[q.range]}, ${formatCount(errors)} of them errors.`
          }
          rows={points}
          series={q.tab === "errors" ? ERRORS : REQUESTS}
          range={q.range}
        />
      </div>

      <h3 className="cs-sub">{q.tab === "errors" ? "Recent errors" : "Recent requests"}</h3>
      {rows.length === 0 ? (
        <p className="cs-empty" role="status">
          {q.tab === "errors" ? `No errors in the last ${RANGE_LABEL[q.range]}.` : `No requests in the last ${RANGE_LABEL[q.range]}.`}
        </p>
      ) : (
        <RecentTable rows={rows} label={q.tab === "errors" ? "Recent errors" : "Recent requests"} now={now} />
      )}
    </section>
  );
}

function RecentTable({ rows, label, now }: { rows: RequestRow[]; label: string; now: number }) {
  return (
    <div className="cs-card">
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
            <tr key={`${r.timestamp}-${r.trace_id}-${i}`} className="cs-row">
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
    </div>
  );
}
