import Link from "next/link";
import type { ReactNode } from "react";
import {
  INCIDENTS_LOAD_FAILED,
  INCIDENTS_RANGES,
  OPEN_PAGING,
  RESOLVED_PAGING,
  channelsHref,
  conditionText,
  eventDuration,
  incidentCount,
  incidentHref,
  incidentsHref,
  metricLabel,
  rulesHref,
  triggeredText,
  unnotifiedText,
} from "@/lib/alerts";
import { formatAgo } from "@/lib/first-data";
import type { Incident, IncidentsRange } from "@/lib/identity";
import { type PageOptions, type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { formatExact } from "@/lib/passkey-settings";
import { Pagination } from "../pagination/pagination";
import { ObIcon } from "../onboarding/ob";
import { RangePicker } from "../range-picker";
import { AlertsHeader, Empty, LoadFailed, StatusBadge } from "./common";

/**
 * `/project/<project>/incidents` (#610), the project's home view: each alert rule with incidents in the
 * range (or one still open), open ones first, with the value that triggered the latest one
 * against the rule's threshold, when it started and how long it lasted or has lasted so far.
 * Each rule links to its timeline. `incidents` is null when the API could not answer; `apps`
 * names the app ids (empty when unknown). `now` is the load time, so relative times render the
 * same on the server and in the browser. Each list is paged on its own (`params` is the page's
 * search params): open incidents under `?opage=`, resolved ones under `?page=`. `channels` is how
 * many alert channels the project has (null when unknown): with none, a banner says nobody is
 * notified and links to add one (#978). `silent` holds the ids of rules with no channel, whose
 * incidents say nobody is notified rather than "not notified yet".
 */
export function IncidentsView({
  project,
  projectName,
  range,
  incidents,
  apps,
  now,
  notice,
  params = {},
  tz,
  channels = null,
  silent = [],
}: {
  project: string;
  projectName: string;
  range: IncidentsRange;
  incidents: Incident[] | null;
  params?: SearchParams;
  apps: Record<string, string>;
  now: number;
  /** Shown above the title (the onboarding setup reminder). */
  notice?: ReactNode;
  /** The user's time zone. */
  tz: string;
  channels?: number | null;
  silent?: string[];
}) {
  const label = INCIDENTS_RANGES.find((r) => r.value === range)?.label ?? range;
  const open = (incidents ?? []).filter((i) => i.open);
  const resolved = (incidents ?? []).filter((i) => !i.open);
  const quiet = new Set(silent);
  return (
    <div className="page al">
      {notice}
      <AlertsHeader project={project} projectName={projectName} tab="incidents" lead="Alert rules that breached their threshold: open ones first, then everything resolved in the range." />

      {channels === 0 ? (
        <div className="al-notice al-notice--warn al-nobody" role="note">
          <ObIcon name="info" />
          <p>
            Nobody is notified: this project has no alert channels.{" "}
            <Link className="cp-link" href={channelsHref(project)}>
              Add a channel
            </Link>
          </p>
        </div>
      ) : null}

      <div className="al-bar">
        <ListHeading title="Open" count={incidents === null ? null : open.length} />
      </div>

      {incidents === null ? (
        <LoadFailed text={INCIDENTS_LOAD_FAILED} href={incidentsHref(project, range)} />
      ) : (
        <>
          {open.length === 0 ? (
            <Empty>No open incidents. Every alert rule is within its threshold.</Empty>
          ) : (
            <IncidentTable label="Open incidents" project={project} rows={open} apps={apps} quiet={quiet} now={now} params={params} paging={OPEN_PAGING} tz={tz} />
          )}

          <div className="al-bar">
            <ListHeading title="Resolved" count={resolved.length} />
            {/* The range only narrows resolved incidents: open ones show whenever they started. */}
            <div className="al-range-group">
              <span aria-hidden="true">Resolved in</span>
              <RangePicker label="Resolved in" options={INCIDENTS_RANGES.map((r) => r.value)} value={range} href={(r) => incidentsHref(project, r)} />
            </div>
          </div>
          {resolved.length === 0 ? (
            <Empty>
              No incidents resolved in the last {label}.{" "}
              {open.length === 0 ? (
                <>
                  Incidents appear here when an{" "}
                  <Link className="cp-link" href={rulesHref(project)}>
                    alert rule
                  </Link>{" "}
                  breaches its threshold.
                </>
              ) : null}
            </Empty>
          ) : (
            <IncidentTable label="Resolved incidents" project={project} rows={resolved} apps={apps} quiet={quiet} now={now} params={params} paging={RESOLVED_PAGING} tz={tz} />
          )}
        </>
      )}
    </div>
  );
}

/** A list's heading with its count: shown as `Open 4`, read as "Open, 4 incidents". */
function ListHeading({ title, count }: { title: string; count: number | null }) {
  return (
    <h2 aria-label={count === null ? undefined : `${title}, ${incidentCount(count)}`}>
      {title}
      {count === null ? null : <span>{count}</span>}
    </h2>
  );
}

function IncidentTable({
  label,
  project,
  rows: all,
  apps,
  quiet,
  now,
  params,
  paging,
  tz,
}: {
  label: string;
  project: string;
  rows: Incident[];
  apps: Record<string, string>;
  quiet: Set<string>;
  now: number;
  params: SearchParams;
  paging: PageOptions;
  tz: string;
}) {
  const { rows, window } = slicePage(all, parsePage(params, paging));
  return (
    <div className="al-card">
      <table className="al-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Status</th>
            <th scope="col" className="al-num">
              Value
            </th>
            <th scope="col">Timeline</th>
            <th scope="col">Notified</th>
            <th scope="col" className="al-num">
              Times fired
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <IncidentRow key={i.rule_id} project={project} i={i} app={apps[i.app_id]} quiet={quiet.has(i.rule_id)} now={now} tz={tz} />
          ))}
        </tbody>
      </table>
      <Pagination pathname={incidentsHref(project)} params={params} total={window.total} label={`${label} pages`} {...paging} />
    </div>
  );
}

function IncidentRow({ project, i, app, quiet, now, tz }: { project: string; i: Incident; app: string | undefined; quiet: boolean; now: number; tz: string }) {
  const e = i.latest;
  // A rule with no channel never notifies anyone: say so rather than "not yet" (#978).
  const unsent = unnotifiedText(e, quiet);
  return (
    <tr>
      <td className="al-first">
        <Link className="al-name" href={incidentHref(project, i.rule_id)}>
          {i.rule_name}
        </Link>
        <span className="al-meta">
          {app ?? "Unknown app"} · {i.environment} · {metricLabel(i.metric)}
        </span>
      </td>
      <td data-label="Status">
        <StatusBadge status={i.status} label={i.open ? undefined : "Resolved"} />
      </td>
      <td className="al-num" data-label="Value">
        {/* The value that opened the latest incident, not where the rule stands now. */}
        <span className="al-value">{triggeredText(i.metric, e.value)}</span>
        <span className="al-meta">threshold {conditionText(i.metric, i.condition, i.threshold)}</span>
      </td>
      <td data-label="Timeline">
        <span>
          Started{" "}
          <time dateTime={e.started_at} title={formatExact(e.started_at, tz)}>
            {formatAgo(e.started_at, now)}
          </time>
        </span>
        <span className="al-meta">{e.ended_at ? `Resolved after ${eventDuration(e, now)}` : `Ongoing for ${eventDuration(e, now)}`}</span>
      </td>
      <td data-label="Notified">
        {e.notified_at ? (
          <time dateTime={e.notified_at} title={formatExact(e.notified_at, tz)}>
            {formatAgo(e.notified_at, now)}
          </time>
        ) : (
          <span className="al-muted">{unsent}</span>
        )}
      </td>
      <td className="al-num" data-label="Times fired">
        <span className="al-mono">{i.events}</span>
      </td>
    </tr>
  );
}
