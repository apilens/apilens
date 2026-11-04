"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import { useTransition } from "react";
import { openProject } from "@/app/(auth)/onboarding/first-data/actions";
import {
  FIRST_DATA_ROWS,
  type FirstData,
  LOAD_FAILED,
  endpointCount,
  formatAgo,
  formatCount,
  formatMs,
  shownPath,
  statusTone,
} from "@/lib/first-data";
import { ObIcon, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue, useOnboardingToast } from "./progress";
import "./first-data.css";

const OPEN_FAILED = "We couldn’t finish setup. Try again in a moment.";

/**
 * "Your first requests" (#335), the last Go live screen: celebrates with data, not confetti. Shows
 * the latest ten requests of the project from the query API as the signed-in user, with the
 * request count, endpoint count and p95 over the last seven days. "Invite your team" goes on to
 * the invite step; "Open project" finishes onboarding on the project's home view.
 */
export function FirstDataScreen({
  step = 4,
  reached = step,
  project,
  data,
  loadedAt,
}: Partial<StepProps> & {
  project: { slug: string; name: string };
  /** Null when the query API could not answer. */
  data: FirstData | null;
  /** When `data` was loaded (ms since the epoch), for the relative times. */
  loadedAt: number;
}) {
  const { go, pending } = useOnboardingContinue(reached);
  const [opening, startOpening] = useTransition();
  const toast = useOnboardingToast();
  const busy = pending || opening;
  const router = useRouter();
  const [reloading, startReloading] = useTransition();
  // Renders the page again on the server, which loads the requests again.
  const reload = () => startReloading(() => router.refresh());

  const open = () =>
    startOpening(async () => {
      try {
        const res = await openProject(project.slug);
        if (!res.ok) toast(res.error);
      } catch (err) {
        unstable_rethrow(err);
        toast(OPEN_FAILED);
      }
    });

  const rows = data?.requests ?? [];

  return (
    <ObShell
      eyebrow="02:44 AM"
      headline={["There it is.", "Real traffic."]}
      body="Every request your service handles now shows up in APILens: who called, what it returned and how long it took."
      receipt={
        <>
          status · <b>live</b> · first data in
        </>
      }
      progress={100}
      step={step}
      reached={reached}
      badge="done"
      title="Your first requests"
      lead={
        <>
          <b>{project.name}</b> is reporting. Here is what APILens has seen so far.
        </>
      }
      footer={
        <div className="ob-foot">
          <span className="sp" />
          <button type="button" className="ah-btn ah-btn--secondary" onClick={open} disabled={busy} aria-disabled={busy || undefined}>
            Open project
          </button>
          <button
            type="button"
            className={`ah-btn ah-btn--primary${busy ? " is-disabled" : ""}${pending ? " is-loading" : ""}`}
            onClick={() => go("invite", "/onboarding/invite")}
            disabled={busy}
            aria-disabled={busy || undefined}
          >
            <ObIcon name="team" />
            Invite your team
          </button>
        </div>
      }
    >
      {data ? (
        <>
          <div className="ob-live fd-facts">
            <dl className="facts">
              <div>
                <dt>Requests</dt>
                <dd>
                  <b>{formatCount(data.total)}</b>
                </dd>
              </div>
              <div>
                <dt>Endpoints</dt>
                <dd>
                  <b>{endpointCount(data.endpoints)}</b>
                </dd>
              </div>
              <div>
                <dt>p95 latency</dt>
                <dd>
                  <b>{formatMs(data.p95Ms)}</b>
                </dd>
              </div>
            </dl>
          </div>

          <section className="ob-f fd-latest" aria-labelledby="fd-latest-h">
            <h2 className="ob-l" id="fd-latest-h">
              Latest requests
              <small>last 7 days, newest first</small>
            </h2>
            {rows.length > 0 ? (
              <div className="ob-card fd-card">
                <table className="fd-table" aria-labelledby="fd-latest-h">
                  <thead>
                    <tr>
                      <th scope="col">Method</th>
                      <th scope="col">Path</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="fd-num">
                        Duration
                      </th>
                      <th scope="col" className="fd-when">
                        When
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, FIRST_DATA_ROWS).map((r, i) => (
                      <tr key={`${r.timestamp}-${r.trace_id}-${i}`}>
                        <td className="fd-method">{r.method}</td>
                        <td className="fd-path" title={shownPath(r)}>
                          {shownPath(r)}
                        </td>
                        <td>
                          <span className={`fd-status fd-${statusTone(r.status_code)}`}>{r.status_code}</span>
                        </td>
                        <td className="fd-num">{formatMs(r.response_time_ms)}</td>
                        <td className="fd-when">
                          <time dateTime={r.timestamp} title={r.timestamp}>
                            {formatAgo(r.timestamp, loadedAt)}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="ob-notice fd-empty" role="status">
                <ObIcon name="info" />
                <p>
                  No requests in the last 7 days yet. They can take a few seconds to show up.{" "}
                  <button type="button" className="cp-link fd-retry" onClick={reload} disabled={reloading}>
                    Refresh
                  </button>
                </p>
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="ob-notice ob-notice--error fd-failed" role="alert">
          <ObIcon name="info" />
          <p>
            {LOAD_FAILED}{" "}
            <button type="button" className="cp-link fd-retry" onClick={reload} disabled={reloading}>
              Try again
            </button>
          </p>
        </div>
      )}
    </ObShell>
  );
}
