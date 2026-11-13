"use client";

import { type FormEvent, useState, useTransition } from "react";
import { resumeProjectIngest, saveProjectGeneral } from "@/app/[project]/settings/general-actions";
import type { ProjectDetail } from "@/lib/identity";
import { formatDay, formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { type GeneralDraft, type GeneralErrors, PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX, checkGeneral, generalDraftOf } from "@/lib/project-general";
import { CopyValue } from "../copy-value";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./general.css";

/** The project and the names of the people its fields name (by user id); null when the API could not answer. */
export type GeneralLoad = { project: ProjectDetail; names: Record<string, string> } | null;

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings` (#815): the project's details (name and description) and its identifiers
 * (slug, project ID, who created it and when). A paused project shows a notice at the top with
 * Resume for those who may resume it. Holders of `project.update` (project admins and editors)
 * edit the details; everyone else sees them read-only.
 */
export function ProjectGeneralSettings({ project, projectName, loaded }: { project: string; projectName: string; loaded: GeneralLoad }) {
  const edit = useCan("project.update").allowed;
  return (
    <div className="page page--measure os pgen">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">General</h1>
      </header>
      {loaded === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s settings. Reload the page to try again.
        </p>
      ) : (
        <GeneralBody key={loaded.project.id} project={project} initial={loaded.project} names={loaded.names} edit={edit} />
      )}
    </div>
  );
}

function GeneralBody({ project, initial, names, edit }: { project: string; initial: ProjectDetail; names: Record<string, string>; edit: boolean }) {
  const [current, setCurrent] = useState(initial);
  return (
    <>
      {current.paused_at ? <PausedNotice project={project} detail={current} names={names} onResumed={setCurrent} /> : null}
      {edit ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>You can see these settings. Only project admins and editors can change them.</span>
        </p>
      )}
      <DetailsCard project={project} current={current} edit={edit} onSaved={setCurrent} />
      <IdentifiersCard detail={current} names={names} />
    </>
  );
}

function PausedNotice({ project, detail, names, onResumed }: { project: string; detail: ProjectDetail; names: Record<string, string>; onResumed: (p: ProjectDetail) => void }) {
  const resume = useCan("project.delete").allowed;
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const by = detail.paused_by ? names[detail.paused_by] : undefined;
  const since = detail.paused_at ? formatDay(detail.paused_at) : "";

  const onResume = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const result = await resumeProjectIngest(project);
      if (result.ok) onResumed(result.project);
      else setError(result.error);
    });
  };

  return (
    <section className="pgen-notice" aria-labelledby="pgen-paused">
      <ObIcon name="info" />
      <div className="t">
        <h2 id="pgen-paused">Ingest is paused</h2>
        <p>
          Since <time dateTime={detail.paused_at ?? undefined} title={detail.paused_at ? formatExact(detail.paused_at) : undefined}>{since}</time>
          {by ? <> by {by}</> : null}, the ingest edge refuses data sent with this project’s keys. Stored data and the dashboard are unaffected.
          {resume ? null : " A project admin can resume it."}
        </p>
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {resume ? (
        <button type="button" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} onClick={onResume} disabled={pending}>
          Resume ingest
        </button>
      ) : null}
    </section>
  );
}

function DetailsCard({ project, current, edit, onSaved }: { project: string; current: ProjectDetail; edit: boolean; onSaved: (p: ProjectDetail) => void }) {
  const [draft, setDraft] = useState<GeneralDraft>(() => generalDraftOf(current));
  const [errors, setErrors] = useState<GeneralErrors>({});
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const saved = generalDraftOf(current);
  const dirty = draft.name !== saved.name || draft.description !== saved.description;
  const count = [...draft.description.trim()].length;
  const over = count > PROJECT_DESCRIPTION_MAX;

  const change = (field: keyof GeneralDraft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    setStatus(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!edit || !dirty || pending) return;
    const checked = checkGeneral(saved, draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      setStatus({ tone: "err", text: "Fix the highlighted fields to save." });
      document.getElementById(checked.errors.name ? "pgen-name" : "pgen-description")?.focus();
      return;
    }
    start(async () => {
      const result = await saveProjectGeneral(project, saved, draft);
      if (!result.ok) {
        setErrors(result.errors ?? {});
        setStatus({ tone: "err", text: result.error });
        return;
      }
      onSaved(result.project);
      setDraft(generalDraftOf(result.project));
      setErrors({});
      setStatus({ tone: "ok", text: "Saved." });
    });
  };

  const reset = () => {
    setDraft(saved);
    setErrors({});
    setStatus(null);
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="pgen-details" noValidate>
      <div className="os-card__head">
        <h2 id="pgen-details">Details</h2>
        <p>How the project appears in the sidebar, in lists and to the people who can see it.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <label className="ob-l" htmlFor="pgen-name">
            Name
          </label>
          <div className={`ob-in${errors.name ? " bad" : ""}${edit ? "" : " ro"}`}>
            <ObIcon name="folder" />
            <input
              id="pgen-name"
              name="name"
              autoComplete="off"
              maxLength={PROJECT_NAME_MAX + 20}
              value={draft.name}
              disabled={!edit || pending}
              onChange={(e) => change("name", e.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "pgen-name-err" : undefined}
            />
          </div>
          {errors.name ? (
            <p id="pgen-name-err" className="ob-err">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="ob-f">
          <label className="ob-l" htmlFor="pgen-description">
            Description<small>optional</small>
          </label>
          {!edit && !current.description ? (
            <p className="pgen-empty">No description yet.</p>
          ) : (
            <textarea
              id="pgen-description"
              name="description"
              className={`pgen-textarea${errors.description || over ? " bad" : ""}`}
              rows={3}
              placeholder="What this project monitors, for example: Storefront API: catalogue, cart and checkout."
              value={draft.description}
              disabled={!edit || pending}
              onChange={(e) => change("description", e.target.value)}
              aria-invalid={errors.description || over ? true : undefined}
              aria-describedby={[edit ? "pgen-description-count" : "", errors.description ? "pgen-description-err" : ""].filter(Boolean).join(" ") || undefined}
            />
          )}
          <div className="pgen-under">
            {errors.description ? (
              <p id="pgen-description-err" className="ob-err">
                {errors.description}
              </p>
            ) : (
              <span />
            )}
            {edit ? (
              <span id="pgen-description-count" className={`pgen-count${over ? " bad" : ""}`}>
                {count} / {PROJECT_DESCRIPTION_MAX}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {edit ? (
        <div className="os-card__foot">
          <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
            {status?.text ?? ""}
          </span>
          {dirty ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={reset} disabled={pending}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || pending}>
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

function IdentifiersCard({ detail, names }: { detail: ProjectDetail; names: Record<string, string> }) {
  const creator = detail.created_by === null ? "Not recorded" : (names[detail.created_by] ?? "A former member");
  return (
    <section className="os-card" aria-labelledby="pgen-ids">
      <div className="os-card__head">
        <h2 id="pgen-ids">Identifiers</h2>
        <p>Use these in SDK configuration, the CLI and API calls. The project ID never changes.</p>
      </div>
      <div className="os-card__body">
        <dl className="pgen-ids">
          <div>
            <dt>Slug</dt>
            <dd>
              <CopyValue value={detail.slug} label="slug" />
            </dd>
          </div>
          <div>
            <dt>Project ID</dt>
            <dd>
              <CopyValue value={detail.id} label="project ID" />
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              {creator} ·{" "}
              <time dateTime={detail.created_at} title={formatExact(detail.created_at)}>
                {formatDay(detail.created_at)}
              </time>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
