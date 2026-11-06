import Link from "next/link";
import { Pagination } from "@/components/pagination/pagination";
import {
  type ChangesFilter,
  type Delta,
  CHANGES_LOAD_FAILED,
  CHANGES_PAGE_SIZES,
  deployHref,
  errorRateDelta,
  exploreHref,
  minutesSoFar,
  p95Delta,
  shortCommit,
  sideP95,
  sideRate,
} from "@/lib/changes";
import { formatAgo } from "@/lib/first-data";
import type { DeployChange, DeploySide, NamedApp } from "@/lib/identity";
import { hrefWithoutPage, type SearchParams } from "@/lib/pagination";
import { ObIcon } from "../onboarding/ob";
import { ChangesFilters } from "./filters";
import "./changes.css";

const TONE_LABEL: Record<Delta["tone"], string> = { worse: "worse", better: "better", flat: "about the same", none: "" };

/** The deploys of one page, with the total across pages; null when the query API could not answer. */
export interface ChangesLoad {
  deploys: DeployChange[];
  total: number;
}

/**
 * `/<project>/changes` (#597): the project's deploys of the last seven days, newest first, each
 * with its error rate and p95 in the hour before and the hour after, the change colored when it
 * is worse (error) or better (ok). The whole row opens the deploy's page (the release is the
 * link); Explore stays as a second action. Filtered by app and environment and paged, all in the
 * URL. `now` is the load time, so relative times render the same on the server and the browser.
 */
export function ChangesView({
  project,
  projectName,
  load,
  now,
  filter,
  params,
  apps,
  environments,
}: {
  project: string;
  projectName: string;
  load: ChangesLoad | null;
  now: number;
  filter: ChangesFilter;
  params: SearchParams;
  /** The project's apps, null when they could not be read. */
  apps: NamedApp[] | null;
  environments: readonly string[];
}) {
  const pathname = `/${encodeURIComponent(project)}/changes`;
  const appName = (id: string) => (id === "" ? "All apps" : (apps?.find((a) => a.id === id)?.name ?? "Unknown app"));
  const filtered = filter.app !== "" || filter.env !== "";
  return (
    <div className="page ch">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Changes</p>
        <h1 className="cp-lede">Deploys</h1>
        <p className="ch-lead">Error rate and p95 latency in the hour before and the hour after each deploy, over the last 7 days. Open a deploy to see what changed with it.</p>
      </header>

      <ChangesFilters pathname={pathname} params={params} filter={filter} apps={apps} environments={environments} />

      {load === null ? (
        <div className="ch-notice ch-notice--error" role="alert">
          <ObIcon name="info" />
          <p>
            {CHANGES_LOAD_FAILED}{" "}
            <a className="cp-link" href={hrefWithoutPage(pathname, params)}>
              Try again
            </a>
          </p>
        </div>
      ) : load.total === 0 ? (
        <div className="ch-notice" role="status">
          <ObIcon name="info" />
          {filtered ? (
            <p>
              No deploys of {filter.app ? appName(filter.app) : "any app"}
              {filter.env ? ` in ${filter.env}` : ""} in the last 7 days.{" "}
              <Link className="cp-link" href={pathname}>
                Show every deploy
              </Link>
            </p>
          ) : (
            <p>
              No deploys in the last 7 days. Set a release (and commit) in the SDK config and each new release shows up here with its before and
              after numbers.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="ch-card">
            <table className="ch-table" aria-label="Deploys">
              <thead>
                <tr>
                  <th scope="col">Release</th>
                  <th scope="col">Deployed</th>
                  <th scope="col" className="ch-num">
                    Error rate
                  </th>
                  <th scope="col" className="ch-num">
                    p95 latency
                  </th>
                  <th scope="col">
                    <span className="ch-sr">Explore</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {load.deploys.map((d) => (
                  <DeployRow key={d.id} project={project} deploy={d} now={now} app={apps ? appName(d.app_id) : ""} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination pathname={pathname} params={params} total={load.total} sizes={CHANGES_PAGE_SIZES} label="Deploys pages" />
        </>
      )}
    </div>
  );
}

/**
 * One deploy. The release is the row's link and stretches over the whole row (`.ch-open::after`),
 * so a click anywhere, a middle-click or ⌘-click opens the deploy and Enter on the focused row
 * follows it; Explore sits above the stretched link as its own target.
 */
function DeployRow({ project, deploy: d, now, app }: { project: string; deploy: DeployChange; now: number; app: string }) {
  const commit = shortCommit(d.commit);
  return (
    <tr className="ch-row">
      <td className="ch-release" data-label="Release">
        <Link className="ch-open" href={deployHref(project, d.id)} prefetch={false}>
          {d.release}
        </Link>
        <span className="ch-meta">
          {commit ? <code title={d.commit}>{commit}</code> : null}
          {app ? <span className="ch-env">{app}</span> : null}
          {d.environment ? <span className="ch-env">{d.environment}</span> : null}
        </span>
      </td>
      <td data-label="Deployed">
        <time dateTime={d.deployed_at} title={d.deployed_at}>
          {formatAgo(d.deployed_at, now)}
        </time>
        {d.after_partial ? <span className="ch-partial">After: {minutesSoFar(d.deployed_at, now)} min so far</span> : null}
      </td>
      <Metric label="Error rate" before={d.before} after={d.after} show={sideRate} delta={errorRateDelta(d.before, d.after)} />
      <Metric label="p95 latency" before={d.before} after={d.after} show={sideP95} delta={p95Delta(d.before, d.after)} />
      <td className="ch-actions">
        <a className="cp-link ch-above" href={exploreHref(project, d, now)} aria-label={`Explore requests after ${d.release}`}>
          Explore
        </a>
      </td>
    </tr>
  );
}

export function Metric({ label, before, after, show, delta }: { label: string; before: DeploySide; after: DeploySide; show: (s: DeploySide) => string; delta: Delta }) {
  return (
    <td className="ch-num" data-label={label}>
      <MetricPair before={before} after={after} show={show} delta={delta} />
    </td>
  );
}

/** `before → after` and the colored delta, or "No traffic to compare". */
export function MetricPair({ before, after, show, delta }: { before: DeploySide; after: DeploySide; show: (s: DeploySide) => string; delta: Delta }) {
  return (
    <>
      <span className="ch-pair">
        <span title="Before">{show(before)}</span>
        <span className="ch-arrow" aria-label="to">
          →
        </span>
        <span title="After">{show(after)}</span>
      </span>
      {delta.tone === "none" ? (
        <span className="ch-delta ch-delta--none">No traffic to compare</span>
      ) : (
        <span className={`ch-delta ch-delta--${delta.tone}`} data-tone={delta.tone} title={TONE_LABEL[delta.tone]}>
          {delta.text}
          <span className="ch-sr"> ({TONE_LABEL[delta.tone]})</span>
        </span>
      )}
    </>
  );
}
