"use client";

import { type FormEvent, useEffect, useState, useTransition } from "react";
import { type EnvironmentsResult, addEnvironment, removeEnvironment, reorderEnvironments, updateEnvironment } from "@/app/[project]/settings/environments-actions";
import {
  ENVIRONMENT_COLORS,
  ENVIRONMENT_COLOR_LABELS,
  inOrder,
  keysText,
  lastSeenText,
  newEnvironmentError,
  removeBlocker,
  sourceLabel,
  stepEnvironment,
  usedText,
} from "@/lib/environments";
import type { Environment, EnvironmentColor, EnvironmentsList, UpdateEnvironmentRequest } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./capture.css";
import "./environments.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/** What a row shows below itself: the remove confirmation, or why it can't be removed. */
type Pending = { name: string; kind: "confirm" } | { name: string; kind: "refused"; text: string } | null;

/**
 * `/<project>/settings/environments` (#816, #753 D11): the project's environments in order, each
 * with its colour, production label, where it came from, when data last arrived and the keys
 * limited to it. Holders of `project.update` (project admins and editors) add, reorder, colour,
 * mark as production, hide and remove; an environment with data can only be hidden. Hidden ones
 * sit in a collapsed group; pickers such as Traffic's leave them out. Viewers see the list only.
 */
export function EnvironmentsSection({ project, projectName, list }: { project: string; projectName: string; list: EnvironmentsList | null }) {
  const manage = useCan("project.update").allowed;
  return (
    <div className="page page--measure os cps env">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Environments</h1>
        <p className="env-lede">SDKs register an environment the first time they send data from it. Its order, colour and production label apply wherever environments are listed.</p>
      </header>
      {list === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s environments. Reload the page to try again.
        </p>
      ) : (
        <Editor project={project} initial={list} manage={manage} />
      )}
    </div>
  );
}

function Editor({ project, initial, manage }: { project: string; initial: EnvironmentsList; manage: boolean }) {
  const [list, setList] = useState(initial);
  const [status, setStatus] = useState<Status>(null);
  const [pendingRow, setPendingRow] = useState<Pending>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const envs = inOrder(list.environments ?? []);
  const visible = envs.filter((e) => !e.hidden);
  const hidden = envs.filter((e) => e.hidden);

  // Buttons are disabled while a change runs, so focus moves once it has finished.
  useEffect(() => {
    if (!focus || busy) return;
    const el = document.getElementById(focus) as HTMLButtonElement | null;
    if (el && !el.disabled) el.focus();
    setFocus(null);
  }, [focus, busy]);

  /** Runs one change; on success shows `done` and moves focus to `then`, on failure says why. */
  const apply = (call: () => Promise<EnvironmentsResult>, done: string, then?: string, onRefused?: (code?: string, text?: string) => boolean) => {
    if (busy) return;
    setStatus(null);
    start(async () => {
      const result = await call();
      if (!result.ok) {
        if (!onRefused?.(result.code, result.error)) setStatus({ tone: "err", text: result.error });
        return;
      }
      setList(result.list);
      setPendingRow(null);
      setStatus({ tone: "ok", text: done });
      if (then) setFocus(then);
    });
  };

  const actions: RowActions = {
    move: (env, step) => {
      const names = stepEnvironment(envs, env.name, step);
      if (!names) return;
      const id = rowId(env.name, step < 0 ? "up" : "down");
      apply(() => reorderEnvironments(project, names), `Moved ${env.name} ${step < 0 ? "up" : "down"}.`, id);
    },
    patch: (env, body, done) => apply(() => updateEnvironment(project, env.name, body), done),
    hide: (env) =>
      apply(() => updateEnvironment(project, env.name, { hidden: true }), `${env.name} is hidden. It still receives data; pickers leave it out.`, "env-hidden-summary"),
    show: (env) => apply(() => updateEnvironment(project, env.name, { hidden: false }), `${env.name} is shown again.`, rowId(env.name, "hide")),
    askRemove: (env) => {
      setStatus(null);
      const why = removeBlocker(env);
      setPendingRow(why ? { name: env.name, kind: "refused", text: why } : { name: env.name, kind: "confirm" });
      setFocus(rowId(env.name, why ? "instead" : "cancel"));
    },
    cancel: (env) => {
      setPendingRow(null);
      setFocus(rowId(env.name, "remove"));
    },
    remove: (env) =>
      apply(
        () => removeEnvironment(project, env.name),
        `${env.name} was removed.`,
        "env-name",
        (code, text) => {
          if (code !== "environment_in_use") return false;
          setPendingRow({ name: env.name, kind: "refused", text: text ?? "" });
          setFocus(rowId(env.name, "instead"));
          return true;
        },
      ),
  };

  return (
    <>
      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>You can see these environments. Only project admins and editors can change them.</span>
        </p>
      )}
      <section className="os-card" aria-labelledby="env-list">
        <div className="os-card__head">
          <h2 id="env-list">Environments</h2>
          <p>
            {usedText(envs.length, list.max_environments)}, hidden ones included. An environment with data can’t be removed; hide it instead.
          </p>
        </div>
        <div className="os-card__body" aria-busy={busy}>
          {envs.length === 0 ? (
            <p className="cps-empty">
              No environments yet. One appears here when an SDK sends data from it{manage ? ", or add one below" : ""}.
            </p>
          ) : visible.length === 0 ? (
            <p className="cps-empty">Every environment is hidden. Show one from the hidden group below.</p>
          ) : (
            <ul className="env-rows" aria-label="Environments in order">
              {visible.map((e, i) => (
                <Row key={e.name} env={e} first={i === 0} last={i === visible.length - 1} manage={manage} busy={busy} pending={pendingRow?.name === e.name ? pendingRow : null} actions={actions} />
              ))}
            </ul>
          )}
          {hidden.length > 0 ? (
            <details className="env-hidden">
              <summary id="env-hidden-summary">
                Hidden environments <span className="env-count">{hidden.length}</span>
              </summary>
              <p className="env-hidden__note">Hidden environments still receive data. Pickers and filters leave them out.</p>
              <ul className="env-rows" aria-label="Hidden environments">
                {hidden.map((e) => (
                  <Row key={e.name} env={e} first last manage={manage} busy={busy} pending={pendingRow?.name === e.name ? pendingRow : null} actions={actions} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        <div className="os-card__foot">
          <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
            {status?.text ?? ""}
          </span>
        </div>
      </section>
      {manage ? <AddEnvironment project={project} list={list} busy={busy} onAdded={(next, name) => apply(async () => ({ ok: true, list: next }), `Added ${name}.`)} /> : null}
    </>
  );
}

interface RowActions {
  move: (env: Environment, step: -1 | 1) => void;
  patch: (env: Environment, body: UpdateEnvironmentRequest, done: string) => void;
  hide: (env: Environment) => void;
  show: (env: Environment) => void;
  askRemove: (env: Environment) => void;
  cancel: (env: Environment) => void;
  remove: (env: Environment) => void;
}

const rowId = (name: string, what: string) => `env-${what}-${name}`;

function Row({ env: e, first, last, manage, busy, pending, actions }: { env: Environment; first: boolean; last: boolean; manage: boolean; busy: boolean; pending: Pending; actions: RowActions }) {
  const titleId = rowId(e.name, "title");
  const colour = e.color ? ENVIRONMENT_COLOR_LABELS[e.color] : "No colour";
  return (
    <li className="env-row" aria-labelledby={titleId}>
      <div className="env-row__head">
        <span className={`env-dot env-dot--${e.color ?? "none"}`} aria-hidden="true" />
        <h3 id={titleId} className="env-name">
          <code>{e.name}</code>
        </h3>
        {e.is_production ? <span className="env-prod">Production</span> : null}
        <span className="env-colour">{colour}</span>
      </div>
      <p className="env-meta">
        {sourceLabel(e.source)} · {e.last_seen_at ? <time dateTime={e.last_seen_at}>{lastSeenText(e.last_seen_at)}</time> : lastSeenText(null)} · {keysText(e.api_keys)}
      </p>
      {manage ? (
        <div className="env-actions">
          {e.hidden ? null : (
            <>
              <button type="button" id={rowId(e.name, "up")} className="ah-btn ah-btn--ghost ah-btn--sm env-step" onClick={() => actions.move(e, -1)} disabled={busy || first} aria-label={`Move ${e.name} up`}>
                <Chevron up />
              </button>
              <button type="button" id={rowId(e.name, "down")} className="ah-btn ah-btn--ghost ah-btn--sm env-step" onClick={() => actions.move(e, 1)} disabled={busy || last} aria-label={`Move ${e.name} down`}>
                <Chevron />
              </button>
            </>
          )}
          <label className="env-pick">
            <span className="sr-only">Colour of {e.name}</span>
            <select
              value={e.color ?? "none"}
              disabled={busy}
              onChange={(ev) => {
                const v = ev.target.value as EnvironmentColor | "none";
                actions.patch(e, { color: v }, v === "none" ? `${e.name} has no colour now.` : `${e.name} is ${ENVIRONMENT_COLOR_LABELS[v].toLowerCase()} now.`);
              }}
            >
              <option value="none">No colour</option>
              {ENVIRONMENT_COLORS.map((c) => (
                <option key={c} value={c}>
                  {ENVIRONMENT_COLOR_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ah-btn ah-btn--ghost ah-btn--sm"
            disabled={busy}
            onClick={() =>
              actions.patch(e, { is_production: !e.is_production }, e.is_production ? `${e.name} is no longer marked as production.` : `${e.name} is marked as production.`)
            }
            aria-label={e.is_production ? `Unmark ${e.name} as production` : `Mark ${e.name} as production`}
          >
            {e.is_production ? "Unmark production" : "Mark as production"}
          </button>
          {e.hidden ? (
            <button type="button" id={rowId(e.name, "show")} className="ah-btn ah-btn--ghost ah-btn--sm" disabled={busy} onClick={() => actions.show(e)} aria-label={`Show ${e.name}`}>
              Show
            </button>
          ) : (
            <button type="button" id={rowId(e.name, "hide")} className="ah-btn ah-btn--ghost ah-btn--sm" disabled={busy} onClick={() => actions.hide(e)} aria-label={`Hide ${e.name}`}>
              Hide
            </button>
          )}
          <button type="button" id={rowId(e.name, "remove")} className="ah-btn ah-btn--ghost ah-btn--sm" disabled={busy} onClick={() => actions.askRemove(e)} aria-label={`Remove ${e.name}`}>
            Remove
          </button>
        </div>
      ) : null}
      {pending?.kind === "confirm" ? (
        <div className="env-confirm" role="group" aria-label={`Remove ${e.name}`}>
          <span>Remove {e.name}? Nothing refers to it, and it comes back if an SDK reports it again.</span>
          <button type="button" id={rowId(e.name, "cancel")} className="ah-btn ah-btn--ghost ah-btn--sm" disabled={busy} onClick={() => actions.cancel(e)} onKeyDown={(k) => k.key === "Escape" && actions.cancel(e)}>
            Cancel
          </button>
          <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${busy ? " is-loading" : ""}`} disabled={busy} onClick={() => actions.remove(e)} onKeyDown={(k) => k.key === "Escape" && actions.cancel(e)}>
            Remove environment
          </button>
        </div>
      ) : pending?.kind === "refused" ? (
        <div className="env-confirm env-refused">
          <span id={rowId(e.name, "why")}>{pending.text}</span>
          {e.hidden ? null : (
            <button type="button" id={rowId(e.name, "instead")} className="ah-btn ah-btn--sm" aria-describedby={rowId(e.name, "why")} disabled={busy} onClick={() => actions.hide(e)}>
              Hide {e.name}
            </button>
          )}
          <button type="button" id={e.hidden ? rowId(e.name, "instead") : undefined} className="ah-btn ah-btn--ghost ah-btn--sm" disabled={busy} onClick={() => actions.cancel(e)}>
            {e.hidden ? "OK" : "Keep it"}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AddEnvironment({ project, list, busy, onAdded }: { project: string; list: EnvironmentsList; busy: boolean; onAdded: (list: EnvironmentsList, name: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, start] = useTransition();
  const envs = list.environments ?? [];
  const full = envs.length >= list.max_environments;

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (busy || sending || full) return;
    const wrong = newEnvironmentError(name, envs, list.max_environments);
    if (wrong) {
      setError(wrong);
      document.getElementById("env-name")?.focus();
      return;
    }
    const sent = name.trim();
    start(async () => {
      const result = await addEnvironment(project, sent);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      onAdded(result.list, sent);
    });
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="env-add" noValidate>
      <div className="os-card__head">
        <h2 id="env-add">Add an environment</h2>
        <p>Add one before its SDK reports it, for example to limit an API key to it. It can be removed until data arrives.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f env-add">
          <label className="ob-l" htmlFor="env-name">
            Name<small>letters, digits, “.”, “_” and “-”, up to 64 characters</small>
          </label>
          <div className={`ob-in${error ? " bad" : ""}`}>
            <input
              id="env-name"
              value={name}
              placeholder="staging"
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              disabled={full}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "env-name-err" : full ? "env-full" : undefined}
              onChange={(ev) => {
                setName(ev.target.value);
                setError(null);
              }}
            />
          </div>
          {error ? (
            <p id="env-name-err" className="ob-err">
              {error}
            </p>
          ) : full ? (
            <p id="env-full" className="env-hint">
              All {list.max_environments} environments are used. Remove one to add another.
            </p>
          ) : null}
        </div>
      </div>
      <div className="os-card__foot">
        <span className="os-status" />
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${sending ? " is-loading" : ""}`} disabled={busy || sending || full || name.trim() === ""}>
          Add environment
        </button>
      </div>
    </form>
  );
}
