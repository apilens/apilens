import { type Delta, CHANGES_LOAD_FAILED, errorRateDelta, exploreHref, minutesSoFar, p95Delta, shortCommit, sideP95, sideRate } from "@/lib/changes";
import { formatAgo } from "@/lib/first-data";
import type { DeployChange, DeploySide } from "@/lib/identity";
import { ObIcon } from "../onboarding/ob";
import "./changes.css";

const TONE_LABEL: Record<Delta["tone"], string> = { worse: "worse", better: "better", flat: "about the same", none: "" };

/**
 * `/<project>/changes` (#597): the project's deploys of the last seven days, newest first, each
 * with its error rate and p95 in the hour before and the hour after, the change colored when it
 * is worse (error) or better (ok), and a link to Explore filtered by the release. `deploys` is
 * null when the query API could not answer. `now` is the load time, so relative times render the
 * same on the server and in the browser.
 */
export function ChangesView({ project, projectName, deploys, now }: { project: string; projectName: string; deploys: DeployChange[] | null; now: number }) {
  return (
    <div className="page ch">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Changes</p>
        <h1 className="cp-lede">Deploys</h1>
        <p className="ch-lead">Error rate and p95 latency in the hour before and the hour after each deploy, over the last 7 days.</p>
      </header>

      {deploys === null ? (
        <div className="ch-notice ch-notice--error" role="alert">
          <ObIcon name="info" />
          <p>
            {CHANGES_LOAD_FAILED}{" "}
            <a className="cp-link" href={`/${encodeURIComponent(project)}/changes`}>
              Try again
            </a>
          </p>
        </div>
      ) : deploys.length === 0 ? (
        <div className="ch-notice" role="status">
          <ObIcon name="info" />
          <p>
            No deploys in the last 7 days. Set a release (and commit) in the SDK config and each new release shows up here with its before and
            after numbers.
          </p>
        </div>
      ) : (
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
              {deploys.map((d, i) => (
                <DeployRow key={`${d.deployed_at}-${d.release}-${d.environment}-${i}`} project={project} deploy={d} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeployRow({ project, deploy: d, now }: { project: string; deploy: DeployChange; now: number }) {
  const commit = shortCommit(d.commit);
  return (
    <tr className="ch-row">
      <td className="ch-release" data-label="Release">
        <b>{d.release}</b>
        <span className="ch-meta">
          {commit ? <code title={d.commit}>{commit}</code> : null}
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
        <a className="cp-link" href={exploreHref(project, d)} aria-label={`Explore requests of ${d.release}`}>
          Explore
        </a>
      </td>
    </tr>
  );
}

function Metric({ label, before, after, show, delta }: { label: string; before: DeploySide; after: DeploySide; show: (s: DeploySide) => string; delta: Delta }) {
  return (
    <td className="ch-num" data-label={label}>
      <span className="ch-pair">
        <span title="Hour before">{show(before)}</span>
        <span className="ch-arrow">→</span>
        <span title="Hour after">{show(after)}</span>
      </span>
      {delta.tone === "none" ? (
        <span className="ch-delta ch-delta--none">No traffic to compare</span>
      ) : (
        <span className={`ch-delta ch-delta--${delta.tone}`} data-tone={delta.tone} title={TONE_LABEL[delta.tone]}>
          {delta.text}
          <span className="ch-sr"> ({TONE_LABEL[delta.tone]})</span>
        </span>
      )}
    </td>
  );
}
