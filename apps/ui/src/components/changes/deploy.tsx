import Link from "next/link";
import { Pagination } from "@/components/pagination/pagination";
import {
  deployHref,
  errorRateDelta,
  exploreHref,
  formatDeployTime,
  formatMinute,
  p95Delta,
  rangeCovering,
  reportLag,
  shortCommit,
  sideP95,
  sideRate,
  splitEndpoints,
  verdict,
  windowText,
} from "@/lib/changes";
import { consumersHref } from "@/lib/consumers";
import { errorsHref, reasonPhrase } from "@/lib/errors";
import { formatAgo, formatCount } from "@/lib/first-data";
import type { DeployComparison, DeployDetail, DeployEndpoint, DeployRef, NamedApp, Project, QueryRange } from "@/lib/identity";
import { type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { commitHref, releaseHref } from "@/lib/repository";
import { endpointHref } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { MetricPair } from "./changes";
import { DeployChart } from "./deploy-chart";
import "./changes.css";

/** What the deploy page could read: the deploy, or why not. */
export type DeployLoad = { state: "ok"; detail: DeployDetail } | { state: "not-found" } | { state: "error" };

/**
 * `/<project>/changes/<id>`: one deploy and what changed with it. The header says what was deployed
 * where and when; the verdict line whether error rate and p95 got better or worse (or that there is
 * not enough traffic to say); the chart shows requests, errors and p95 per minute around it; the
 * endpoint table what moved per endpoint, worst first; and the new error codes, exceptions and the
 * consumers that got errors after it. `comparison` is null when the API could not answer it.
 */
export function DeployView({
  project,
  projectName,
  load,
  comparison,
  apps,
  params,
  now,
  id,
  repository = null,
}: {
  project: string;
  projectName: string;
  /** The deploy id in the URL. */
  id: string;
  load: DeployLoad;
  comparison: DeployComparison | null;
  apps: NamedApp[] | null;
  params: SearchParams;
  now: number;
  /** The project's commit and release URL templates (Settings › Integrations); null when unset or unread. */
  repository?: Pick<Project, "commit_url_template" | "release_url_template"> | null;
}) {
  const changes = `/${encodeURIComponent(project)}/changes`;
  const crumb = (
    <p className="cp-h">
      {projectName} ·{" "}
      <Link className="cp-link" href={changes}>
        Changes
      </Link>
    </p>
  );
  if (load.state !== "ok") {
    return (
      <div className="page ch chd">
        <header className="pagehead">
          {crumb}
          <h1 className="cp-lede">{load.state === "not-found" ? "Deploy not found" : "Deploy"}</h1>
        </header>
        <div className={`ch-notice${load.state === "error" ? " ch-notice--error" : ""}`} role={load.state === "error" ? "alert" : "status"}>
          <ObIcon name="info" />
          {load.state === "not-found" ? (
            <p>
              This project has no deploy with this id. It may be older than the data APILens keeps, or the link may be from another project.{" "}
              <Link className="cp-link" href={changes}>
                See every deploy
              </Link>
            </p>
          ) : (
            <p>
              We couldn’t load this deploy just now.{" "}
              <a className="cp-link" href={deployHref(project, id)}>
                Try again
              </a>
            </p>
          )}
        </div>
      </div>
    );
  }

  const { detail } = load;
  const d = detail.deploy;
  const open = d.after_partial;
  const app = d.app_id === "" ? "All apps (project-wide deploy)" : (apps?.find((a) => a.id === d.app_id)?.name ?? (apps === null ? "An app of this project" : "A removed app"));
  const range = rangeCovering(Date.parse(detail.before_from), now);
  const v = verdict(d.before, d.after, open);
  const lag = reportLag(d.deployed_at, d.received_at);
  const nextInWindow = detail.next && Date.parse(detail.next.deployed_at) < Date.parse(detail.after_to) ? detail.next : null;
  const series = detail.series ?? [];
  // The repository link wins for the commit; the deploy's own URL stays the release link, else the repository's.
  const commitUrl = commitHref(repository?.commit_url_template, d.commit) ?? (d.url || null);
  const releaseUrl = d.url || releaseHref(repository?.release_url_template, d.release);

  return (
    <div className="page ch chd">
      <header className="pagehead chd-head">
        {crumb}
        <div className="chd-titlebar">
          <h1 className="cp-lede chd-title">{d.release}</h1>
          <DeploySteps project={project} previous={detail.previous} next={detail.next} />
        </div>
        <dl className="chd-facts">
          <div>
            <dt>Commit</dt>
            <dd>
              {d.commit ? (
                commitUrl ? (
                  <a className="cp-link" href={commitUrl} target="_blank" rel="noreferrer noopener" title={d.commit}>
                    <code>{shortCommit(d.commit)}</code>
                  </a>
                ) : (
                  <code title={d.commit}>{shortCommit(d.commit)}</code>
                )
              ) : releaseUrl ? (
                <a className="cp-link" href={releaseUrl} target="_blank" rel="noreferrer noopener">
                  Release link
                </a>
              ) : (
                <span className="chd-none">Not reported</span>
              )}
            </dd>
          </div>
          <div>
            <dt>App</dt>
            <dd>{app}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{d.environment || "All environments"}</dd>
          </div>
          <div>
            <dt>Deployed</dt>
            <dd>
              <time dateTime={d.deployed_at}>{formatDeployTime(d.deployed_at)}</time> <span className="chd-none">({formatAgo(d.deployed_at, now)})</span>
            </dd>
          </div>
          <div>
            <dt>Reported</dt>
            <dd>
              Deploy API{lag ? `, ${lag}` : ""}
              {releaseUrl && d.commit ? (
                <>
                  {" · "}
                  <a className="cp-link" href={releaseUrl} target="_blank" rel="noreferrer noopener">
                    Release link
                  </a>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
        <p className="chd-actions">
          <a className="cp-link" href={exploreHref(project, d, now, "after")}>
            Requests after in Explore
          </a>
          <a className="cp-link" href={exploreHref(project, d, now, "before")}>
            Requests before
          </a>
        </p>
      </header>

      <section className={`chd-verdict chd-verdict--${v.tone}`} aria-labelledby="chd-verdict-h">
        <div className="chd-verdict__text">
          <h2 id="chd-verdict-h">{v.headline}</h2>
          <p>
            {v.detail} {windowText(detail.window_minutes, detail.after_minutes, open)}
            {open ? "; the numbers update as traffic comes in." : "."}
          </p>
          {nextInWindow ? (
            <p className="chd-note">
              <Link className="cp-link" href={deployHref(project, nextInWindow.id)}>
                {nextInWindow.release}
              </Link>{" "}
              was deployed {Math.max(1, Math.round((Date.parse(nextInWindow.deployed_at) - Date.parse(d.deployed_at)) / 60_000))} min later, so the
              after window includes its traffic too.
            </p>
          ) : null}
        </div>
        <dl className="chd-kpis">
          <div>
            <dt>Error rate</dt>
            <dd>
              <MetricPair before={d.before} after={d.after} show={sideRate} delta={errorRateDelta(d.before, d.after)} />
            </dd>
          </div>
          <div>
            <dt>p95 latency</dt>
            <dd>
              <MetricPair before={d.before} after={d.after} show={sideP95} delta={p95Delta(d.before, d.after)} />
            </dd>
          </div>
          <div>
            <dt>Requests</dt>
            <dd>
              <span className="ch-pair">
                <span title="Before">{formatCount(d.before.requests)}</span>
                <span className="ch-arrow" aria-label="to">
                  →
                </span>
                <span title="After">{formatCount(d.after.requests)}</span>
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="ch-card chd-section" aria-labelledby="chd-chart-h">
        <div className="chd-section__head">
          <h2 id="chd-chart-h">Around the deploy</h2>
          <p>
            Per minute, {formatMinute(detail.before_from)} to {formatMinute(detail.after_to)}
            {open ? " (now)" : ""}.
          </p>
        </div>
        {series.some((p) => p.requests > 0) ? (
          <DeployChart series={series} deployMinute={detail.deploy_minute} release={d.release} />
        ) : (
          <p className="chd-empty">No requests in the hour before or after this deploy{d.environment ? ` in ${d.environment}` : ""}.</p>
        )}
      </section>

      {comparison === null ? (
        <div className="ch-notice ch-notice--error" role="alert">
          <ObIcon name="info" />
          <p>
            We couldn’t load the per-endpoint comparison just now.{" "}
            <a className="cp-link" href={deployHref(project, d.id)}>
              Try again
            </a>
          </p>
        </div>
      ) : (
        <>
          <EndpointsSection project={project} detail={detail} endpoints={comparison.endpoints ?? []} params={params} range={range} open={open} />
          <div className="chd-grid">
            <NewErrors project={project} comparison={comparison} range={range} env={d.environment} />
            <Consumers project={project} comparison={comparison} range={range} />
          </div>
        </>
      )}
    </div>
  );
}

/** The previous and next deploy of the same app and environment. */
function DeploySteps({ project, previous, next }: { project: string; previous?: DeployRef; next?: DeployRef }) {
  return (
    <nav className="chd-steps" aria-label="Other deploys of this app and environment">
      {previous ? (
        <Link className="chd-step" href={deployHref(project, previous.id)} rel="prev" title={formatDeployTime(previous.deployed_at)}>
          <span aria-hidden="true">←</span> <span className="chd-step__lbl">Previous</span> <b>{previous.release}</b>
        </Link>
      ) : (
        <span className="chd-step" aria-disabled="true">
          <span aria-hidden="true">←</span> <span className="chd-step__lbl">No earlier deploy</span>
        </span>
      )}
      {next ? (
        <Link className="chd-step" href={deployHref(project, next.id)} rel="next" title={formatDeployTime(next.deployed_at)}>
          <span className="chd-step__lbl">Next</span> <b>{next.release}</b> <span aria-hidden="true">→</span>
        </Link>
      ) : (
        <span className="chd-step" aria-disabled="true">
          <span className="chd-step__lbl">Latest deploy</span>
        </span>
      )}
    </nav>
  );
}

function EndpointsSection({
  project,
  detail,
  endpoints,
  params,
  range,
  open,
}: {
  project: string;
  detail: DeployDetail;
  endpoints: DeployEndpoint[];
  params: SearchParams;
  range: QueryRange;
  open: boolean;
}) {
  const { compared, added, gone } = splitEndpoints(endpoints);
  const page = slicePage(compared, parsePage(params));
  const env = detail.deploy.environment;
  const pathname = deployHref(project, detail.deploy.id);
  const link = (e: DeployEndpoint) => endpointHref(project, e, { range, env });
  return (
    <section className="ch-card chd-section" aria-labelledby="chd-ep-h">
      <div className="chd-section__head">
        <h2 id="chd-ep-h">Endpoints</h2>
        <p>Endpoints with traffic on both sides, the biggest regression in error rate or p95 first.</p>
      </div>
      {compared.length === 0 ? (
        <p className="chd-empty">No endpoint had traffic both before and after this deploy{open ? " yet" : ""}.</p>
      ) : (
        <>
          <table className="ch-table chd-ep" aria-label="Endpoints before and after the deploy">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col" className="ch-num">
                  Requests
                </th>
                <th scope="col" className="ch-num">
                  Error rate
                </th>
                <th scope="col" className="ch-num">
                  p95 latency
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((e) => (
                <tr key={`${e.method} ${e.path}`} className="ch-row">
                  <td className="ch-release" data-label="Endpoint">
                    <Link className="ch-open chd-ep__name" href={link(e)} prefetch={false}>
                      <span className="chd-method">{e.method}</span> <code>{e.path}</code>
                    </Link>
                  </td>
                  <td className="ch-num" data-label="Requests">
                    <span className="ch-pair">
                      <span title="Before">{formatCount(e.before.requests)}</span>
                      <span className="ch-arrow" aria-label="to">
                        →
                      </span>
                      <span title="After">{formatCount(e.after.requests)}</span>
                    </span>
                  </td>
                  <td className="ch-num" data-label="Error rate">
                    <MetricPair before={e.before} after={e.after} show={sideRate} delta={errorRateDelta(e.before, e.after)} />
                  </td>
                  <td className="ch-num" data-label="p95 latency">
                    <MetricPair before={e.before} after={e.after} show={sideP95} delta={p95Delta(e.before, e.after)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination pathname={pathname} params={params} total={page.window.total} label="Endpoints pages" />
        </>
      )}
      <div className="chd-split">
        <EndpointList
          title="New in this release"
          empty={`No endpoint got its first requests after this deploy${open ? " yet" : ""}.`}
          rows={added.map((e) => ({ e, count: e.after.requests, href: link(e) }))}
          unit="after"
        />
        <EndpointList
          title="No requests since the deploy"
          note={open ? "Low-traffic endpoints can land here early in the after window." : undefined}
          empty="Every endpoint with traffic before also had traffic after."
          rows={gone.map((e) => ({ e, count: e.before.requests, href: link(e) }))}
          unit="before"
        />
      </div>
    </section>
  );
}

function EndpointList({ title, note, empty, rows, unit }: { title: string; note?: string; empty: string; rows: { e: DeployEndpoint; count: number; href: string }[]; unit: string }) {
  return (
    <div className="chd-list">
      <h3>
        {title} <span className="chd-count">{formatCount(rows.length)}</span>
      </h3>
      {note && rows.length > 0 ? <p className="chd-hint">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="chd-hint">{empty}</p>
      ) : (
        <ul>
          {rows.map(({ e, count, href }) => (
            <li key={`${e.method} ${e.path}`}>
              <Link className="cp-link chd-ep__name" href={href} prefetch={false}>
                <span className="chd-method">{e.method}</span> <code>{e.path}</code>
              </Link>
              <span className="chd-n">
                {formatCount(count)} {count === 1 ? "request" : "requests"} {unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewErrors({ project, comparison, range, env }: { project: string; comparison: DeployComparison; range: QueryRange; env: string }) {
  const statuses = comparison.statuses ?? [];
  const exceptions = comparison.exceptions ?? [];
  const newStatuses = statuses.filter((s) => s.new);
  const newExceptions = exceptions.filter((x) => x.new);
  const errors = (code?: number) => errorsHref(project, code ? { tab: "status", code, range, env } : { range, env });
  return (
    <section className="ch-card chd-section" aria-labelledby="chd-err-h">
      <div className="chd-section__head">
        <h2 id="chd-err-h">New errors</h2>
        <p>
          Status codes and exceptions seen after the deploy but not in the hour before.{" "}
          <Link className="cp-link" href={errors()}>
            Open Errors
          </Link>
        </p>
      </div>
      {newStatuses.length === 0 && newExceptions.length === 0 ? (
        <p className="chd-empty">No new error status codes or exceptions after this deploy.</p>
      ) : (
        <ul className="chd-errs">
          {newStatuses.map((s) => (
            <li key={`s${s.status_code}`}>
              <Link className="chd-code" data-class={s.status_code >= 500 ? "5xx" : "4xx"} href={errors(s.status_code)}>
                {s.status_code}
              </Link>
              <span className="chd-err__what">{reasonPhrase(s.status_code) || "Error status"}</span>
              <span className="chd-n">{formatCount(s.after)} after</span>
            </li>
          ))}
          {newExceptions.map((x) => (
            <li key={`x${x.exception_type}:${x.message}`}>
              <span className="chd-exc">{x.exception_type || "Exception"}</span>
              <span className="chd-err__what" title={x.message}>
                {x.message}
                {x.path ? (
                  <span className="chd-hint">
                    {" "}
                    in {x.method} {x.path}
                  </span>
                ) : null}
              </span>
              <span className="chd-n">{formatCount(x.after)} after</span>
            </li>
          ))}
        </ul>
      )}
      <SeenBoth statuses={statuses.filter((s) => !s.new)} />
    </section>
  );
}

/** The error codes on both sides (or only before), with their counts: context for the new ones. */
function SeenBoth({ statuses }: { statuses: DeployComparison["statuses"] }) {
  const rows = statuses ?? [];
  if (rows.length === 0) return null;
  return (
    <details className="chd-more">
      <summary>Other error codes ({formatCount(rows.length)})</summary>
      <ul>
        {rows.map((s) => (
          <li key={s.status_code}>
            <span className="chd-code chd-code--plain" data-class={s.status_code >= 500 ? "5xx" : "4xx"}>
              {s.status_code}
            </span>
            <span className="ch-pair">
              <span title="Before">{formatCount(s.before)}</span>
              <span className="ch-arrow" aria-label="to">
                →
              </span>
              <span title="After">{formatCount(s.after)}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Consumers({ project, comparison, range }: { project: string; comparison: DeployComparison; range: QueryRange }) {
  const rows = comparison.consumers ?? [];
  const more = comparison.consumers_affected - rows.length;
  return (
    <section className="ch-card chd-section" aria-labelledby="chd-con-h">
      <div className="chd-section__head">
        <h2 id="chd-con-h">Consumers affected</h2>
        <p>
          Consumers that got 4xx or 5xx answers after the deploy.{" "}
          <Link className="cp-link" href={consumersHref(project, { range })}>
            Open Consumers
          </Link>
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="chd-empty">No identified consumer got an error after this deploy.</p>
      ) : (
        <ul className="chd-errs">
          {rows.map((c) => (
            <li key={c.consumer_id}>
              <Link className="cp-link chd-err__what" href={consumersHref(project, { consumer: c.consumer_id, tab: "errors", range })}>
                {c.consumer_name || c.consumer_id}
              </Link>
              <span className="chd-n">
                {formatCount(c.after_errors)} of {formatCount(c.after_requests)} after
                {c.before_errors === 0 ? <span className="chd-tag">none before</span> : <span className="chd-hint"> · {formatCount(c.before_errors)} before</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? <p className="chd-hint">and {formatCount(more)} more.</p> : null}
    </section>
  );
}
