import type { ReactNode } from "react";
import type { Retention } from "@/lib/identity";
import { LINKS, extLink } from "@/lib/links";
import { afterRetention, formatPeriod, retentionDocsUrl } from "@/lib/retention";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";
import "./retention.css";

/** What the page loaded: the signals, or the sentence for a read that failed. */
export type RetentionLoad = Retention | { error: string };

/**
 * `/<project>/settings/retention` (#818, #753 D10): how long each signal is kept and what happens
 * after, from `GET /projects/{slug}/retention`. Read-only for everyone: retention is set per
 * install by its operator, never per project. The header renders at once; the table streams in.
 */
export function RetentionFrame({ project, projectName, children }: { project: string; projectName: string; children: ReactNode }) {
  return (
    <div className="page page--measure os cps rt">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Retention</h1>
        <p className="rt-lede">
          How long {projectName} keeps each kind of data. For what each request stores and which fields are masked, open{" "}
          <a className="cp-link" href={`/${project}/settings/privacy`}>
            Privacy
          </a>
          .
        </p>
      </header>
      {children}
      <section className="os-card" aria-labelledby="rt-who">
        <div className="os-card__head">
          <h2 id="rt-who">Who can change it</h2>
          <p>
            Retention is the same for every project on this APILens install. Only the install’s operator can change it, in the server config (
            <code>retention.&lt;signal&gt;</code>), and shortening a period deletes data older than the new one.{" "}
            <a className="cp-link" {...extLink(retentionDocsUrl(LINKS.docs))}>
              How to change retention
            </a>
          </p>
        </div>
        <div className="os-card__body" />
      </section>
    </div>
  );
}

/** The periods per signal, an empty line, or the load error. */
export function RetentionTable({ data }: { data: RetentionLoad }) {
  if ("error" in data) {
    return (
      <p className="pk-load-err" role="alert">
        {data.error}
      </p>
    );
  }
  const signals = data.signals ?? [];
  return (
    <section className="os-card" aria-labelledby="rt-periods">
      <div className="os-card__head">
        <h2 id="rt-periods">Retention periods</h2>
        <p>Data older than its period is deleted automatically and can’t be recovered.</p>
      </div>
      <div className="os-card__body">
        {signals.length === 0 ? (
          <p className="cps-empty">This install reports no retention periods.</p>
        ) : (
          <table className="pk-table rt-table" aria-labelledby="rt-periods">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Kept for</th>
                <th scope="col">After that</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.key} className="pk-row">
                  <th scope="row">
                    <span className="rt-label">{s.label}</span>
                    {s.covers ? <span className="rt-covers">{s.covers}</span> : null}
                  </th>
                  <td data-label="Kept for" className="rt-period">
                    {formatPeriod(s.period_days)}
                    {s.configurable ? null : <span className="rt-fixed">Fixed</span>}
                  </td>
                  <td data-label="After that">{afterRetention(s, signals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** Placeholder rows while the periods load. */
export function RetentionLoading() {
  return (
    <section className="os-card rt-loading" aria-busy="true" aria-labelledby="rt-loading">
      <div className="os-card__head">
        <h2 id="rt-loading">Retention periods</h2>
        <p className="pk-sr" aria-live="polite">
          Loading the retention periods…
        </p>
      </div>
      <div className="os-card__body" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rt-bone-row">
            <span className="rt-bone rt-bone--name" />
            <span className="rt-bone rt-bone--cell" />
            <span className="rt-bone rt-bone--wide" />
          </div>
        ))}
      </div>
    </section>
  );
}
