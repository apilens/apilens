"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useId, useState, useTransition } from "react";
import { CodeBlock } from "@/components/onboarding/install";
import { keysPath } from "@/lib/api-keys";
import { formatAgo } from "@/lib/first-data";
import type { IngestStatus } from "@/lib/identity";
import { KEY_PLACEHOLDER, appIdFor, appNameNote } from "@/lib/install";
import { LINKS, extLink } from "@/lib/links";
import { formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { radioKeyTarget } from "@/lib/radio-group";
import { type AppSetupStatus, SDK_LANGUAGES, lastDataLine, reportedSdk, sdkDocs, setupSnippets } from "@/lib/sdk-setup";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "../onboarding/install.css";
import "./sdk-setup.css";

/** What the page loaded: each part is null when the API could not answer. */
export interface SdkSetupLoad {
  apps: AppSetupStatus[] | null;
  ingest: IngestStatus | null;
  /** `APILENS_PUBLIC_INGEST_URL`, where the snippets send data. */
  ingestUrl: string;
}

/**
 * `/<project>/settings/sdk` (#817): the install steps onboarding showed (#333), for every SDK, with
 * the key as a placeholder (a stored key is never shown; keys are created under API keys and shown
 * once), the app name and the ingest URL; then, per app and environment, the SDK last reported and
 * when data last arrived, or "Waiting for the first request" with a refresh.
 */
export function SdkSetup({ project, projectName, load }: { project: string; projectName: string; load: SdkSetupLoad }) {
  return (
    <div className="page page--measure os sdk">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">SDK setup</h1>
      </header>
      <InstallCard project={project} ingestUrl={load.ingestUrl} />
      <StatusCard apps={load.apps} ingest={load.ingest} />
    </div>
  );
}

function InstallCard({ project, ingestUrl }: { project: string; ingestUrl: string }) {
  const [language, setLanguage] = useState(SDK_LANGUAGES[0].id);
  const tabsId = useId();
  const canCreateKey = useCan("api_keys.create").allowed;
  const appId = appIdFor(project);
  const snippets = setupSnippets(language, project, ingestUrl);
  const docs = sdkDocs(LINKS.docs, language);
  const current = SDK_LANGUAGES.find((l) => l.id === language) ?? SDK_LANGUAGES[0];
  const tabId = (id: string) => `${tabsId}-${id}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = SDK_LANGUAGES.findIndex((l) => l.id === language);
    const to = radioKeyTarget(e.key, from, SDK_LANGUAGES.map(() => false));
    if (to === null) return;
    e.preventDefault();
    setLanguage(SDK_LANGUAGES[to].id);
    document.getElementById(tabId(SDK_LANGUAGES[to].id))?.focus();
  };

  return (
    <section className="os-card" aria-labelledby="sdk-install">
      <div className="os-card__head">
        <h2 id="sdk-install">Install an SDK</h2>
        <p>Add the middleware to your service, run it and send it a request.</p>
      </div>
      <div className="os-card__body">
        <dl className="sdk-facts">
          <div>
            <dt>App name</dt>
            <dd>
              <code>{appId}</code>
            </dd>
          </div>
          <div>
            <dt>Ingest URL</dt>
            <dd>
              <code>{ingestUrl}</code>
            </dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>
              <code>{KEY_PLACEHOLDER}</code>
            </dd>
          </div>
        </dl>
        <p className="sdk-note">
          Replace <code>{KEY_PLACEHOLDER}</code> with an ingest key. A key’s full value is shown once, when it’s created.{" "}
          {canCreateKey ? (
            <a className="cp-link" href={keysPath(project)}>
              Create a key in API keys
            </a>
          ) : (
            <>
              Ask an admin for one, or see the project’s keys in{" "}
              <a className="cp-link" href={keysPath(project)}>
                API keys
              </a>
              .
            </>
          )}
        </p>

        <div className="sdk-tabs" role="tablist" aria-label="SDK language" onKeyDown={onKeyDown}>
          {SDK_LANGUAGES.map((l) => (
            <button
              key={l.id}
              id={tabId(l.id)}
              type="button"
              role="tab"
              aria-selected={l.id === language}
              aria-controls={`${tabsId}-panel`}
              tabIndex={l.id === language ? 0 : -1}
              onClick={() => setLanguage(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <div className="sdk-panel ins-snippets" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={tabId(language)}>
          {snippets.map((s) => (
            <CodeBlock key={`${language}-${s.id}`} snippet={s} />
          ))}
          <p className="sdk-note">{appNameNote(appId)}</p>
          {docs ? (
            <p className="sdk-note">
              <a className="cp-link" {...extLink(docs.href)}>
                {current.label} SDK docs ({docs.framework})
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** `now`, refreshed every 30 s so "ago" stays true while the page is open. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function StatusCard({ apps, ingest }: { apps: AppSetupStatus[] | null; ingest: IngestStatus | null }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [checked, setChecked] = useState(false);
  const now = useNow();
  const ago = (at: string) => (now === null ? `at ${formatExact(at)}` : formatAgo(at, now));
  const refresh = () => {
    setChecked(false);
    startRefresh(() => {
      router.refresh();
      setChecked(true);
    });
  };
  const waiting = apps !== null && (apps.length === 0 || apps.some((a) => a.reports?.length === 0));

  return (
    <section className="os-card" aria-labelledby="sdk-status">
      <div className="os-card__head">
        <h2 id="sdk-status">Status</h2>
        <p>{lastDataLine(ingest, ago)}</p>
      </div>
      <div className="os-card__body">
        {apps === null ? (
          <p className="pk-load-err" role="alert">
            Couldn’t load this project’s apps. Reload the page to try again.
          </p>
        ) : apps.length === 0 ? (
          <p className="sdk-wait">Waiting for the first request. An app appears here once its SDK sends data.</p>
        ) : (
          apps.map((a) => <AppStatusRows key={a.app.id} status={a} />)
        )}
        {waiting ? (
          <div className="sdk-refresh">
            <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={refresh} disabled={refreshing}>
              {refreshing ? "Checking…" : "Refresh"}
            </button>
            <span role="status" aria-live="polite">
              {checked && !refreshing ? "Checked just now." : ""}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AppStatusRows({ status }: { status: AppSetupStatus }) {
  const { app, reports } = status;
  const titleId = `sdk-app-${app.id}`;
  return (
    <div className="sdk-app">
      <h3 id={titleId}>
        {app.name}
        {app.name !== app.slug ? <code>{app.slug}</code> : null}
      </h3>
      {reports === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load what {app.name}’s SDKs reported. Reload the page to try again.
        </p>
      ) : reports.length === 0 ? (
        <p className="sdk-wait">Waiting for the first request.</p>
      ) : (
        <table className="pk-table sdk-table" aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">Environment</th>
              <th scope="col">SDK</th>
              <th scope="col">Last reported</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.environment} className="pk-row">
                <th scope="row" data-label="Environment">
                  {r.environment}
                </th>
                <td data-label="SDK">{reportedSdk(r)}</td>
                <td data-label="Last reported">
                  <time dateTime={r.received_at}>{formatExact(r.received_at)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
