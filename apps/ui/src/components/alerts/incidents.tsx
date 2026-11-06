import Link from "next/link";
import type { ReactNode } from "react";
import {
  INCIDENTS_LOAD_FAILED,
  INCIDENTS_RANGES,
  OPEN_PAGING,
  RESOLVED_PAGING,
  conditionText,
  eventDuration,
  formatMetric,
  incidentHref,
  incidentsHref,
  metricLabel,
  rulesHref,
} from "@/lib/alerts";
import { formatAgo } from "@/lib/first-data";
import type { Incident, IncidentsRange } from "@/lib/identity";
import { type PageOptions, type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { formatExact } from "@/lib/passkey-settings";
import { Pagination } from "../pagination/pagination";
import { AlertsHeader, Empty, LoadFailed, StatusBadge } from "./common";

/**
 * `/<project>/incidents` (#610), the project's home view: each alert rule with incidents in the
 * range (or one still open), open ones first, with the value that triggered the latest one
 * against the rule's threshold, when it started and how long it lasted or has lasted so far.
 * Each rule links to its timeline. `incidents` is null when the API could not answer; `apps`
 * names the app ids (empty when unknown). `now` is the load time, so relative times render the
 * same on the server and in the browser. Each list is paged on its own (`params` is the page's
 * search params): open incidents under `?opage=`, resolved ones under `?page=`.
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
}) {
  const label = INCIDENTS_RANGES.find((r) => r.value === range)?.label ?? range;
  const open = (incidents ?? []).filter((i) => i.open);
  const resolved = (incidents ?? []).filter((i) => !i.open);
  return (
    <div className="page al">
      {notice}
      <AlertsHeader project={project} projectName={projectName} tab="incidents" title="Incidents" lead="Alert rules that breached their threshold: open ones first, then everything resolved in the range." />

      <div className="al-bar">
        <h2>
          Open<span>{incidents === null ? "" : open.length}</span>
        </h2>
        <nav className="al-range" aria-label="Range">
          {INCIDENTS_RANGES.map((r) => (
            <Link key={r.value} href={incidentsHref(project, r.value)} aria-current={r.value === range ? "page" : undefined}>
              {r.label}
            </Link>
          ))}
        </nav>
      </div>

      {incidents === null ? (
        <LoadFailed text={INCIDENTS_LOAD_FAILED} href={incidentsHref(project, range)} />
      ) : (
        <>
          {open.length === 0 ? (
            <Empty>No open incidents. Every alert rule is within its threshold.</Empty>
          ) : (
            <IncidentTable label="Open incidents" project={project} rows={open} apps={apps} now={now} params={params} paging={OPEN_PAGING} />
          )}

          <div className="al-bar">
            <h2>
              Resolved<span>{resolved.length}</span>
            </h2>
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
            <IncidentTable label="Resolved incidents" project={project} rows={resolved} apps={apps} now={now} params={params} paging={RESOLVED_PAGING} />
          )}
        </>
      )}
    </div>
  );
}

function IncidentTable({
  label,
  project,
  rows: all,
  apps,
  now,
  params,
  paging,
}: {
  label: string;
  project: string;
  rows: Incident[];
  apps: Record<string, string>;
  now: number;
  params: SearchParams;
  paging: PageOptions;
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
            <th scope="col" className="al-num">
              Incidents
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <IncidentRow key={i.rule_id} project={project} i={i} app={apps[i.app_id]} now={now} />
          ))}
        </tbody>
      </table>
      <Pagination pathname={incidentsHref(project)} params={params} total={window.total} label={`${label} pages`} {...paging} />
    </div>
  );
}

function IncidentRow({ project, i, app, now }: { project: string; i: Incident; app: string | undefined; now: number }) {
  const e = i.latest;
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
        <span className="al-value">{formatMetric(i.metric, e.value)}</span>
        <span className="al-meta">threshold {conditionText(i.metric, i.condition, i.threshold)}</span>
      </td>
      <td data-label="Timeline">
        <span>
          Started{" "}
          <time dateTime={e.started_at} title={formatExact(e.started_at)}>
            {formatAgo(e.started_at, now)}
          </time>
        </span>
        <span className="al-meta">
          {e.ended_at ? (
            <>
              Resolved after {eventDuration(e, now)}
              {e.notified_at ? "" : ", no notification sent"}
            </>
          ) : (
            <>
              Ongoing for {eventDuration(e, now)}
              {e.notified_at ? ", notified" : ", not notified yet"}
            </>
          )}
        </span>
      </td>
      <td className="al-num" data-label="Incidents">
        <span className="al-mono">{i.events}</span>
      </td>
    </tr>
  );
}
