"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { saveCapturePolicy } from "@/app/[project]/settings/capture-actions";
import {
  APPLIES_WITHIN,
  DEFAULT_POLICY,
  type FieldErrors,
  MAX_PAYLOAD_LIMIT,
  type PolicyDraft,
  capturePath,
  checkDraft,
  draftOf,
  effectiveRows,
  policyValues,
  runtimeLine,
  samePolicy,
} from "@/lib/capture-policy";
import type { AppEnvironmentReport, CapturePolicy, NamedApp, PutCapturePolicyRequest } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";

/** What the page loaded: each part is null when the API could not answer. */
export interface CaptureLoad {
  apps: NamedApp[] | null;
  /** The app on screen: `?app=`, else the project's first; null without apps. */
  app: NamedApp | null;
  policy: CapturePolicy | null;
  reports: AppEnvironmentReport[] | null;
}

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings/capture` (#598): an app's remote capture policy (kill switch, sample rate,
 * headers and bodies, body size cap) and, per environment, what its SDKs reported running with
 * next to the narrower of the two, which is what applies. Holders of `capture.manage` (project
 * admins, organization owners and admins) edit; everyone else sees the same values read-only.
 * Turning capture off asks first. Saved changes reach the SDKs within 60 s.
 */
export function CaptureSettings({ project, projectName, userId, load }: { project: string; projectName: string; userId: string; load: CaptureLoad }) {
  const manage = useCan("capture.manage").allowed;
  const [saved, setSaved] = useState<CapturePolicy | null>(load.policy);
  const { apps, app } = load;

  return (
    <div className="os cps">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Capture policy</h1>
      </header>

      {apps === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s apps. Reload the page to try again.
        </p>
      ) : app === null ? (
        <section className="os-card" aria-labelledby="cps-none">
          <div className="os-card__head">
            <h2 id="cps-none">No apps yet</h2>
            <p>Capture policies are set per app. An app appears here once it is registered on {projectName}.</p>
          </div>
          <div className="os-card__body" />
        </section>
      ) : (
        <>
          {apps.length > 1 ? <AppPicker project={project} apps={apps} current={app} /> : null}
          {manage ? null : (
            <p className="os-note">
              <ObIcon name="lock" />
              <span>You can see this policy. Only project admins can change it.</span>
            </p>
          )}
          {load.policy === null || saved === null ? (
            <section className="os-card" aria-labelledby="cps-title">
              <div className="os-card__head">
                <h2 id="cps-title">Capture</h2>
              </div>
              <div className="os-card__body">
                <p className="pk-load-err" role="alert">
                  Couldn’t load the capture policy of {app.name}. Reload the page to try again.
                </p>
              </div>
            </section>
          ) : (
            <PolicyCard project={project} app={app} saved={saved} manage={manage} userId={userId} onSaved={setSaved} />
          )}
          <ReportsCard reports={load.reports} policy={saved ? policyValues(saved) : null} />
        </>
      )}
    </div>
  );
}

function AppPicker({ project, apps, current }: { project: string; apps: NamedApp[]; current: NamedApp }) {
  const router = useRouter();
  return (
    <div className="ob-f cps-app">
      <label className="ob-l" htmlFor="cps-app">
        App<small>each app has its own policy</small>
      </label>
      <div className="ob-in">
        <select id="cps-app" value={current.slug} onChange={(e) => router.push(capturePath(project, e.target.value))}>
          {apps.map((a) => (
            <option key={a.id} value={a.slug}>
              {a.name === a.slug ? a.slug : `${a.name} (${a.slug})`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** When and by whom the policy was last saved, or that it never was. */
function savedLine(policy: CapturePolicy, userId: string): string {
  if (!policy.updated_at) return "Never changed: the app captures everything.";
  const who = policy.updated_by === userId ? "you" : "a project admin";
  return `Last changed ${formatExact(policy.updated_at)} by ${who}. Every change is recorded in the audit log.`;
}

interface PolicyCardProps {
  project: string;
  app: NamedApp;
  saved: CapturePolicy;
  manage: boolean;
  userId: string;
  onSaved: (policy: CapturePolicy) => void;
}

function PolicyCard({ project, app, saved, manage, userId, onSaved }: PolicyCardProps) {
  const [draft, setDraft] = useState<PolicyDraft>(() => draftOf(policyValues(saved)));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  const checked = checkDraft(draft);
  const dirty = !checked.ok || !samePolicy(checked.policy, policyValues(saved));
  const off = !draft.enabled;

  const edit = (patch: Partial<PolicyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
    setStatus(null);
    setConfirming(false);
  };

  const save = (policy: PutCapturePolicyRequest) => {
    start(async () => {
      const result = await saveCapturePolicy(project, saved.app_id, policy);
      setConfirming(false);
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        return;
      }
      onSaved(result.policy);
      setDraft(draftOf(policyValues(result.policy)));
      setStatus({
        tone: "ok",
        text: result.policy.enabled ? `Saved. ${app.name}’s SDKs apply it within ${APPLIES_WITHIN}.` : `Saved. ${app.name}’s SDKs stop capturing within ${APPLIES_WITHIN}.`,
      });
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage || !dirty || pending) return;
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    // Turning capture off stops all data for the app: ask first.
    if (saved.enabled && !checked.policy.enabled) {
      setConfirming(true);
      return;
    }
    save(checked.policy);
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="cps-title" noValidate>
      <div className="os-card__head">
        <h2 id="cps-title">Capture</h2>
        <p>
          What <b className="cps-app-name">{app.name}</b>’s SDKs send. Saved changes apply within {APPLIES_WITHIN}, on the SDKs’ next heartbeat.
        </p>
      </div>
      <div className="os-card__body">
        <Toggle
          id="cps-enabled"
          on={draft.enabled}
          disabled={!manage || pending}
          label="Capture requests"
          help={
            draft.enabled
              ? "The SDKs send the requests they observe, as set below."
              : "Off: the SDKs send nothing for this app until capture is turned back on."
          }
          onChange={(on) => edit({ enabled: on })}
        />

        <div className={`cps-fields${off ? " is-off" : ""}`}>
          <div className="ob-f">
            <label className="ob-l" htmlFor="cps-rate">
              Sample rate<small>share of requests kept, 0 to 100%</small>
            </label>
            <div className={`ob-in cps-num${errors.percent ? " bad" : ""}${manage ? "" : " ro"}`}>
              <input
                id="cps-rate"
                inputMode="decimal"
                autoComplete="off"
                value={draft.percent}
                disabled={!manage || pending}
                aria-invalid={errors.percent !== undefined}
                aria-describedby={errors.percent ? "cps-rate-err" : undefined}
                onChange={(e) => edit({ percent: e.target.value })}
              />
              <span className="cps-unit" aria-hidden="true">
                %
              </span>
            </div>
            {errors.percent ? (
              <p id="cps-rate-err" className="ob-err">
                {errors.percent}
              </p>
            ) : null}
          </div>

          <Toggle
            id="cps-headers"
            on={draft.capture_headers}
            disabled={!manage || pending}
            label="Headers"
            help="Request and response headers. Sensitive ones are stripped regardless."
            onChange={(on) => edit({ capture_headers: on })}
          />
          <Toggle
            id="cps-req-body"
            on={draft.capture_request_body}
            disabled={!manage || pending}
            label="Request bodies"
            help="What clients send, after the SDK’s masking."
            onChange={(on) => edit({ capture_request_body: on })}
          />
          <Toggle
            id="cps-resp-body"
            on={draft.capture_response_body}
            disabled={!manage || pending}
            label="Response bodies"
            help="What the app answers, after the SDK’s masking."
            onChange={(on) => edit({ capture_response_body: on })}
          />

          <div className="ob-f">
            <label className="ob-l" htmlFor="cps-cap">
              Body size cap<small>bytes · empty for no cap beyond the SDK’s own</small>
            </label>
            <div className={`ob-in cps-num${errors.cap ? " bad" : ""}${manage ? "" : " ro"}`}>
              <input
                id="cps-cap"
                inputMode="numeric"
                autoComplete="off"
                placeholder="No cap"
                value={draft.cap}
                disabled={!manage || pending}
                aria-invalid={errors.cap !== undefined}
                aria-describedby={errors.cap ? "cps-cap-err" : "cps-cap-help"}
                onChange={(e) => edit({ cap: e.target.value })}
              />
              <span className="cps-unit" aria-hidden="true">
                bytes
              </span>
            </div>
            {errors.cap ? (
              <p id="cps-cap-err" className="ob-err">
                {errors.cap}
              </p>
            ) : (
              <p id="cps-cap-help" className="os-help">
                Longer bodies are truncated. At most {MAX_PAYLOAD_LIMIT.toLocaleString("en-US")} bytes (1 MiB).
              </p>
            )}
          </div>
        </div>

        {confirming ? (
          <DisableConfirm
            appName={app.name}
            pending={pending}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              if (checked.ok) save(checked.policy);
            }}
          />
        ) : null}

        <p className="cps-audit">{savedLine(saved, userId)}</p>
      </div>
      {manage ? (
        <div className="os-card__foot">
          <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
            {status?.text ?? ""}
          </span>
          {dirty ? (
            <button
              type="button"
              className="ah-btn ah-btn--ghost ah-btn--sm"
              disabled={pending}
              onClick={() => {
                setDraft(draftOf(policyValues(saved)));
                setErrors({});
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          ) : null}
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || pending || confirming}>
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

function Toggle({ id, on, disabled, label, help, onChange }: { id: string; on: boolean; disabled: boolean; label: string; help: ReactNode; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className="os-toggle" role="switch" aria-checked={on} aria-labelledby={`${id}-l`} aria-describedby={`${id}-h`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="t">
        <b id={`${id}-l`}>{label}</b>
        <span id={`${id}-h`}>{help}</span>
      </span>
      <span className={`ob-sw${on ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}

function DisableConfirm({ appName, pending, onCancel, onConfirm }: { appName: string; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="os-confirm"
      role="group"
      aria-labelledby="cps-confirm-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onCancel();
      }}
    >
      <p id="cps-confirm-title">
        <b>Stop capturing {appName}?</b> Within {APPLIES_WITHIN} its SDKs stop sending requests, and nothing is recorded until capture is turned back on.
      </p>
      <div className="row">
        <button ref={cancel} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={onConfirm} disabled={pending}>
          Stop capturing
        </button>
      </div>
    </div>
  );
}

/** Per environment: the SDK's runtime, and each setting as the policy, the SDK and what applies. */
function ReportsCard({ reports, policy }: { reports: AppEnvironmentReport[] | null; policy: PutCapturePolicyRequest | null }) {
  return (
    <section className="os-card" aria-labelledby="cps-sdk">
      <div className="os-card__head">
        <h2 id="cps-sdk">What the SDKs run with</h2>
        <p>The config each environment’s SDK reported when it started. The SDK applies the narrower of it and this policy.</p>
      </div>
      <div className="os-card__body">
        {reports === null ? (
          <p className="pk-load-err" role="alert">
            Couldn’t load what the SDKs reported. Reload the page to try again.
          </p>
        ) : reports.length === 0 ? (
          <p className="cps-empty">No SDK has reported its config yet. SDKs report it once each time the app starts.</p>
        ) : (
          reports.map((r) => <EnvironmentReport key={r.environment} report={r} policy={policy ?? DEFAULT_POLICY} />)
        )}
      </div>
    </section>
  );
}

function EnvironmentReport({ report, policy }: { report: AppEnvironmentReport; policy: PutCapturePolicyRequest }) {
  const rows = effectiveRows(policy, report.config ?? {});
  const runtime = runtimeLine(report);
  const titleId = `cps-env-${report.environment}`;
  return (
    <div className="cps-env">
      <div className="cps-env__head">
        <h3 id={titleId}>{report.environment}</h3>
        <p>
          {runtime ? `${runtime} · ` : ""}reported <time dateTime={report.received_at}>{formatExact(report.received_at)}</time>
        </p>
      </div>
      <table className="pk-table cps-table" aria-labelledby={titleId}>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">This policy</th>
            <th scope="col">SDK config</th>
            <th scope="col">Applies</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="pk-row">
              <th scope="row" data-label="Setting">
                {row.label}
              </th>
              <td data-label="This policy">{row.policy}</td>
              <td data-label="SDK config">{row.sdk ?? <span className="pk-muted">Not reported</span>}</td>
              <td data-label="Applies">
                <b className="cps-applies">{row.effective}</b>
                {row.narrowedBySdk ? <span className="cps-why">set by the SDK</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
