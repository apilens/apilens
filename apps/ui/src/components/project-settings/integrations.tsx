"use client";

import Link from "next/link";
import { type FormEvent, useState, useTransition } from "react";
import { saveRepositoryUrl } from "@/app/[project]/settings/integrations-actions";
import type { Project } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { MAX_REPOSITORY_URL, PREVIEW_COMMIT, checkRepositoryUrl, commitHref, commitTemplateOf } from "@/lib/repository";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./integrations.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings/integrations` (#820): the project's source repository link, which turns
 * commit and release ids on Changes into links, and a pointer to Alert channels for
 * notifications. Holders of `project.update` edit; viewers see the link read-only.
 */
export function IntegrationsSettings({ project, projectName, loaded }: { project: string; projectName: string; loaded: Project | null }) {
  const manage = useCan("project.update").allowed;
  return (
    <div className="page page--measure os int">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Integrations</h1>
      </header>
      {loaded === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s integrations. Reload the page to try again.
        </p>
      ) : (
        <>
          {manage ? null : (
            <p className="os-note">
              <ObIcon name="lock" />
              <span>You can see these settings. Only project admins and editors can change them.</span>
            </p>
          )}
          <RepositoryCard project={project} initial={loaded.repository_url ?? ""} manage={manage} />
        </>
      )}
      <section className="os-card" aria-labelledby="int-notify">
        <div className="os-card__head">
          <h2 id="int-notify">Notifications</h2>
          <p>Slack, Microsoft Teams, webhooks and email are alert channels: add them where alerts are sent.</p>
        </div>
        <div className="os-card__body">
          <p className="int-line">
            <Link className="cp-link" href={`/${encodeURIComponent(project)}/settings/alerts`}>
              Go to Alert channels
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}

function RepositoryCard({ project, initial, manage }: { project: string; initial: string; manage: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [url, setUrl] = useState(initial);
  // The API's reason for the last refused link, shown next to the field until it is edited.
  const [serverError, setServerError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();

  const checked = checkRepositoryUrl(url);
  const dirty = url.trim() !== saved;
  const fieldError = serverError ?? (dirty && !checked.ok ? checked.error : null);
  const preview = checked.ok && checked.url ? commitHref(commitTemplateOf(checked.url), PREVIEW_COMMIT) : null;

  const save = (value: string, done: string) => {
    if (!manage || pending) return;
    start(async () => {
      const result = await saveRepositoryUrl(project, value);
      if (result.ok) {
        const next = result.project.repository_url ?? "";
        setSaved(next);
        setUrl(next);
        setServerError(null);
        setStatus({ tone: "ok", text: done });
      } else {
        if (result.code === "invalid_request") setServerError(result.error);
        setStatus({ tone: "err", text: result.code === "invalid_request" ? "Repository link not saved." : result.error });
      }
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !checked.ok) return;
    save(checked.url, checked.url ? "Repository link saved." : "Repository link removed.");
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="int-repo" noValidate>
      <div className="os-card__head">
        <h2 id="int-repo">Source repository</h2>
        <p>Link the repository this project deploys from, and commit and release ids on Changes open there. A link only: APILens never reads the repository.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <label className="ob-l" htmlFor="int-repo-url">
            Repository URL<small>github.com, gitlab.com or bitbucket.org</small>
          </label>
          <div className={`ob-in${fieldError ? " bad" : ""}${manage ? "" : " ro"}`}>
            <ObIcon name="link" />
            <input
              id="int-repo-url"
              name="repository_url"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://github.com/acme/shop"
              maxLength={MAX_REPOSITORY_URL + 20}
              value={url}
              disabled={!manage}
              onChange={(e) => {
                setUrl(e.target.value);
                setServerError(null);
                setStatus(null);
              }}
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError ? "int-repo-err" : preview ? "int-repo-preview" : undefined}
            />
          </div>
          {fieldError ? (
            <p id="int-repo-err" className="ob-err">
              {fieldError}
            </p>
          ) : null}
          {preview ? (
            <p id="int-repo-preview" className="int-preview">
              A commit links to <code>{preview}</code>
            </p>
          ) : checked.ok && checked.url && !fieldError ? (
            <p id="int-repo-preview" className="int-preview">
              Commit links are built for github.com, gitlab.com and bitbucket.org; other hosts keep commit ids as text.
            </p>
          ) : null}
        </div>
      </div>
      {manage ? (
        <div className="os-card__foot">
          <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
            {status?.text ?? ""}
          </span>
          {saved && !dirty ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => save("", "Repository link removed.")} disabled={pending}>
              Remove
            </button>
          ) : null}
          {dirty ? (
            <button
              type="button"
              className="ah-btn ah-btn--ghost ah-btn--sm"
              onClick={() => {
                setUrl(saved);
                setServerError(null);
                setStatus(null);
              }}
              disabled={pending}
            >
              Cancel
            </button>
          ) : null}
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || !checked.ok || pending}>
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}
