"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { createHealthCheck, deleteHealthCheck } from "@/app/[project]/settings/health-check-actions";
import { EVENTS_SHOWN, type HealthCheckField, PROBE_POLICY, attemptsLabel, formatLatency, probeOutcome } from "@/lib/health-checks";
import type { HealthCheck, HealthCheckEvent, HealthCheckProbe, NamedApp } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";
import "./health-checks.css";

/** What the page loaded: each part is null when the API could not answer. */
export interface HealthChecksLoad {
  apps: NamedApp[] | null;
  /** The project's recent environments, offered when typing one. */
  environments: string[];
  checks: HealthCheck[] | null;
  /** Each check's latest failures, newest first; null when they could not be loaded. */
  events: Record<string, HealthCheckEvent[] | null>;
}

/**
 * `/<project>/settings/health-checks` (#608): the project's active HTTP checks. Each check shows
 * its status and latest probe, and its latest failures with the failed request (status, latency,
 * error, attempts and the start of the response body, masked by the privacy policy). Project
 * admins add and delete checks; the API refuses anyone else (403) and the form says so.
 */
export function HealthChecks({ project, projectName, load }: { project: string; projectName: string; load: HealthChecksLoad }) {
  const { apps, checks } = load;
  const appName = (id: string) => apps?.find((a) => a.id === id)?.name ?? "Unknown app";
  return (
    <div className="page page--measure os cps hc">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Health checks</h1>
        <p className="hc-lede">{PROBE_POLICY} A failing check notifies every notification channel of the project.</p>
      </header>

      <section className="os-card" aria-labelledby="hc-list">
        <div className="os-card__head">
          <h2 id="hc-list">Checks</h2>
          <p>Each check’s latest probe and its last {EVENTS_SHOWN} failures, with the failed request.</p>
        </div>
        <div className="os-card__body">
          {checks === null ? (
            <p className="pk-load-err" role="alert">
              Couldn’t load this project’s health checks. Reload the page to try again.
            </p>
          ) : checks.length === 0 ? (
            <p className="cps-empty">No health checks yet. Add the health endpoint of an app below and APILens starts probing it within a minute.</p>
          ) : (
            <ul className="hc-checks">
              {checks.map((c) => (
                <CheckItem key={c.id} project={project} check={c} app={appName(c.app_id)} events={load.events[c.id] ?? null} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {apps === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s apps. Reload the page to try again.
        </p>
      ) : apps.length === 0 ? (
        <section className="os-card" aria-labelledby="hc-none">
          <div className="os-card__head">
            <h2 id="hc-none">No apps yet</h2>
            <p>A health check belongs to an app. Register an app on {projectName} to add one.</p>
          </div>
          <div className="os-card__body" />
        </section>
      ) : (
        <AddCheck project={project} apps={apps} environments={load.environments} />
      )}
    </div>
  );
}

function statusOf(c: HealthCheck): { tone: "up" | "down" | "idle"; label: string } {
  if (!c.enabled) return { tone: "idle", label: "Paused" };
  if (!c.checked_at) return { tone: "idle", label: "Not checked yet" };
  return c.status === "down" ? { tone: "down", label: "Failing" } : { tone: "up", label: "Passing" };
}

function CheckItem({ project, check: c, app, events }: { project: string; check: HealthCheck; app: string; events: HealthCheckEvent[] | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const status = statusOf(c);
  const titleId = `hc-${c.id}`;

  const remove = () =>
    start(async () => {
      const result = await deleteHealthCheck(project, c.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });

  return (
    <li className="hc-check" aria-labelledby={titleId}>
      <div className="hc-check__head">
        <span className={`hc-status hc-status--${status.tone}`}>{status.label}</span>
        <h3 id={titleId} className="hc-url">
          <span className="hc-method">GET</span>
          <code>{c.url}</code>
        </h3>
        {confirming ? (
          <span className="hc-confirm">
            <span>Delete this check and its failures?</span>
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
            <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={remove} disabled={pending}>
              Delete check
            </button>
          </span>
        ) : (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setConfirming(true)} aria-label={`Delete the check of ${c.url}`}>
            Delete
          </button>
        )}
      </div>
      <p className="hc-meta">
        {app} · {c.environment} · expects {c.expected_status}
        {c.last_result ? (
          <>
            {" · "}last probe{" "}
            <time dateTime={c.last_result.checked_at} title={formatExact(c.last_result.checked_at)}>
              {formatExact(c.last_result.checked_at)}
            </time>
            : {probeOutcome(c.last_result)} in {formatLatency(c.last_result.latency_ms)}
          </>
        ) : null}
      </p>
      {error ? (
        <p className="ob-err" role="alert">
          {error}
        </p>
      ) : null}
      {events === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load the failures of this check. Reload the page to try again.
        </p>
      ) : events.length > 0 ? (
        <div className="hc-failures">
          <h4>Recent failures</h4>
          <ol>
            {events.map((e) => (
              <Failure key={e.id} event={e} />
            ))}
          </ol>
        </div>
      ) : null}
    </li>
  );
}

/** One failure: when it started and ended, and the request that failed. */
function Failure({ event: e }: { event: HealthCheckEvent }) {
  return (
    <li className="hc-failure">
      <p className="hc-failure__when">
        <time dateTime={e.started_at}>{formatExact(e.started_at)}</time>
        {e.ended_at ? (
          <>
            {" "}
            to <time dateTime={e.ended_at}>{formatExact(e.ended_at)}</time>
          </>
        ) : (
          <span className="hc-open">ongoing</span>
        )}
      </p>
      <Probe probe={e.failure} />
    </li>
  );
}

function Probe({ probe: p }: { probe: HealthCheckProbe }) {
  return (
    <>
      <dl className="hc-facts">
        <div>
          <dt>Result</dt>
          <dd>{probeOutcome(p)}</dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>{formatLatency(p.latency_ms)}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{attemptsLabel(p.attempts)}</dd>
        </div>
      </dl>
      {p.body_snippet ? (
        <figure className="hc-body">
          <figcaption>
            Response body{p.body_truncated ? ", first 1 KB" : ""}, masked by the privacy policy
          </figcaption>
          <pre>{p.body_snippet}</pre>
        </figure>
      ) : null}
    </>
  );
}

const FIELD_IDS: Record<HealthCheckField, string> = {
  app_id: "hc-app",
  environment: "hc-env",
  url: "hc-url",
  expected_status: "hc-expected",
};

function AddCheck({ project, apps, environments }: { project: string; apps: NamedApp[]; environments: string[] }) {
  const router = useRouter();
  const [appId, setAppId] = useState(apps[0]?.id ?? "");
  const [environment, setEnvironment] = useState(environments[0] ?? "production");
  const [url, setUrl] = useState("");
  const [expected, setExpected] = useState("200");
  const [error, setError] = useState<{ text: string; field?: HealthCheckField } | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const change = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError(null);
    setAdded(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    start(async () => {
      const result = await createHealthCheck(project, { app_id: appId, environment, url, expected_status: expected });
      if (!result.ok) {
        setError({ text: result.error, field: result.field });
        if (result.field) document.getElementById(FIELD_IDS[result.field])?.focus();
        return;
      }
      setUrl("");
      setAdded(`Added. The first probe of ${result.check.url} runs within a minute.`);
      router.refresh();
    });
  };

  const bad = (f: HealthCheckField) => (error?.field === f ? " bad" : "");
  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="hc-add" noValidate>
      <div className="os-card__head">
        <h2 id="hc-add">Add a check</h2>
        <p>Use an endpoint that answers fast and touches what the app needs, such as a database ping. Redirects are not followed.</p>
      </div>
      <div className="os-card__body hc-form">
        <div className="ob-f">
          <label className="ob-l" htmlFor="hc-app">
            App
          </label>
          <div className={`ob-in${bad("app_id")}`}>
            <select id="hc-app" value={appId} onChange={(e) => change(setAppId)(e.target.value)}>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name === a.slug ? a.slug : `${a.name} (${a.slug})`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="ob-f">
          <label className="ob-l" htmlFor="hc-env">
            Environment
          </label>
          <div className={`ob-in${bad("environment")}`}>
            <input id="hc-env" value={environment} list="hc-envs" maxLength={64} autoComplete="off" spellCheck={false} onChange={(e) => change(setEnvironment)(e.target.value)} />
            <datalist id="hc-envs">
              {environments.map((env) => (
                <option key={env} value={env} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="ob-f">
          <label className="ob-l" htmlFor="hc-url">
            URL<small>GET, http or https, a public address</small>
          </label>
          <div className={`ob-in${bad("url")}`}>
            <input
              id="hc-url"
              type="url"
              value={url}
              placeholder="https://api.example.com/healthz"
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === "url"}
              onChange={(e) => change(setUrl)(e.target.value)}
            />
          </div>
        </div>
        <div className="ob-f hc-expected">
          <label className="ob-l" htmlFor="hc-expected">
            Expected status
          </label>
          <div className={`ob-in${bad("expected_status")}`}>
            <input id="hc-expected" inputMode="numeric" value={expected} maxLength={3} onChange={(e) => change(setExpected)(e.target.value.replace(/\D/g, ""))} />
          </div>
        </div>
      </div>
      <div className="os-card__foot">
        <span className={`os-status${error ? " err" : added ? " ok" : ""}`} role="status" aria-live="polite">
          {error?.text ?? added ?? ""}
        </span>
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || url.trim() === ""}>
          Add check
        </button>
      </div>
    </form>
  );
}
