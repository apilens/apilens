import Link from "next/link";
import { conditionText, eventDuration, filterParts, formatMetric, formatSpan, incidentHref, incidentsHref, ruleHref, ruleSummary, scheduleText } from "@/lib/alerts";
import type { AlertEvent, AlertRule } from "@/lib/identity";
import { type SearchParams, trailHrefs } from "@/lib/pagination";
import { formatExact } from "@/lib/passkey-settings";
import { Pagination } from "../pagination/pagination";
import { Empty, LoadFailed, StatusBadge } from "./common";
import { IncidentChart } from "./incident-chart";

/**
 * `/<project>/incidents/<rule>` (#610): one alert rule's incidents as a timeline, newest first:
 * when each triggered and with what value, when the first notification went out, and when it
 * resolved (or how long it has been open), a page at a time with Newer and Older (the API's
 * cursors, `nextCursor` null on the oldest page), above them their values against the threshold
 * as a hoverable chart. `rule` is the rule as saved; `events` is null when the API could not
 * answer; `params` are the page's search params. `now` is the load time.
 */
export function IncidentTimeline({
  project,
  projectName,
  rule,
  app,
  events,
  nextCursor,
  params,
  now,
}: {
  project: string;
  projectName: string;
  rule: AlertRule;
  app: string | undefined;
  events: AlertEvent[] | null;
  nextCursor: string | null;
  params: SearchParams;
  now: number;
}) {
  const pages = trailHrefs(incidentHref(project, rule.id), params, nextCursor);
  return (
    <div className="page al">
      <header className="pagehead al-head">
        <div>
          <p className="cp-h">
            <Link className="cp-link" href={incidentsHref(project)}>
              {projectName} · Incidents
            </Link>
          </p>
          <h1 className="cp-lede">{rule.name}</h1>
          <p className="al-lead">{rule.description || ruleSummary(rule)}</p>
        </div>
        <Link className="ah-btn ah-btn--secondary ah-btn--sm" href={ruleHref(project, rule.id)}>
          View rule
        </Link>
      </header>

      <dl className="al-summary">
        <div>
          <dt>Status</dt>
          <dd>{rule.enabled ? rule.state ? <StatusBadge status={rule.state.status} /> : "Not evaluated yet" : "Disabled"}</dd>
        </div>
        <div>
          <dt>Breaches when</dt>
          <dd>
            {ruleSummary(rule)}
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {[app ?? "Unknown app", rule.environment, ...filterParts(rule)].join(" · ")}
          </dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>{scheduleText(rule)}</dd>
        </div>
        <div>
          <dt>Latest value</dt>
          <dd className="al-mono">{rule.state ? formatMetric(rule.metric, rule.state.value) : "–"}</dd>
        </div>
      </dl>

      <div className="al-bar">
        <h2>Timeline</h2>
      </div>
      {events === null ? (
        <LoadFailed text="We couldn’t load this rule’s incidents just now." href={incidentHref(project, rule.id)} />
      ) : events.length === 0 ? (
        pages.page > 1 ? (
          <Empty>
            No older incidents.{" "}
            <Link className="cp-link" href={pages.newestHref}>
              Back to the newest
            </Link>
          </Empty>
        ) : (
          <Empty>This rule has no incidents yet.</Empty>
        )
      ) : (
        <div className="al-card">
          {events.length > 1 ? <IncidentChart rule={rule} events={events} now={now} /> : null}
          <ol className="al-timeline" aria-label="Incidents of this rule">
            {events.map((e) => (
              <li key={e.id} className={`al-event${e.ended_at ? "" : " al-event--open"}`}>
                <div className="al-event__head">
                  <StatusBadge status={e.ended_at ? "ok" : "triggered"} label={e.ended_at ? "Resolved" : "Open"} />
                  <span className="al-value">{formatMetric(rule.metric, e.value)}</span>
                  <span className="al-muted">threshold {conditionText(rule.metric, rule.condition, rule.threshold)}</span>
                </div>
                <ul className="al-event__steps">
                  <li>
                    <b>Triggered</b> <time dateTime={e.started_at}>{formatExact(e.started_at)}</time>
                  </li>
                  <li>
                    {e.notified_at ? (
                      <>
                        <b>Notified</b> <time dateTime={e.notified_at}>{formatExact(e.notified_at)}</time>
                      </>
                    ) : rule.notify_after_s > 0 && !e.ended_at ? (
                      `Notifies once it holds for ${formatSpan(rule.notify_after_s)}`
                    ) : (
                      "No notification sent"
                    )}
                  </li>
                  <li>
                    {e.ended_at ? (
                      <>
                        <b>Resolved</b> <time dateTime={e.ended_at}>{formatExact(e.ended_at)}</time>, after {eventDuration(e, now)}
                      </>
                    ) : (
                      <>
                        <b>Ongoing</b> for {eventDuration(e, now)}
                      </>
                    )}
                  </li>
                </ul>
              </li>
            ))}
          </ol>
          {pages.olderHref || pages.newerHref ? (
            <div className="al-pager">
              <p>
                Page {pages.page}, newest first
                {pages.page > 2 ? (
                  <>
                    {" · "}
                    <Link className="cp-link" href={pages.newestHref}>
                      Newest
                    </Link>
                  </>
                ) : null}
              </p>
              <Pagination mode="cursor" newerHref={pages.newerHref} olderHref={pages.olderHref} label="Incident pages" />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
