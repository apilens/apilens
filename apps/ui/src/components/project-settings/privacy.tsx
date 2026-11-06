"use client";

import { type FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import { savePrivacyPolicy } from "@/app/[project]/settings/privacy-actions";
import type { PrivacyPolicy } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import {
  APPLIES_WITHIN,
  type DraftErrors,
  LISTS,
  type ListKey,
  MAX_PATTERNS,
  type PrivacyDraft,
  SAMPLE,
  type Sample,
  checkDraft,
  defaultsOf,
  draftOf,
  listsOf,
  sameLists,
  testSample,
  validLists,
} from "@/lib/privacy-policy";
import { REDACTED, type RedactorDefaults, compileRedactor } from "@/lib/privacy-redact";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./privacy.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings/privacy` (#599): the project's server-side deny list. Three pattern lists
 * (query parameters, headers, body fields) on top of the built-ins, which show as locked rows;
 * each pattern is checked as it is typed. A tester masks a sample request with a client-side
 * port of the edge's redactor, unsaved patterns included, so a pattern can be tried before it is
 * saved. Holders of `project.update` (owners, admins and members) edit; viewers see the same
 * lists read-only and can still use the tester.
 */
export function PrivacySettings({ projectName, project, policy }: { project: string; projectName: string; policy: PrivacyPolicy | null }) {
  const manage = useCan("project.update").allowed;
  return (
    <div className="page page--measure os prv">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Privacy</h1>
      </header>
      {policy === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s privacy policy. Reload the page to try again.
        </p>
      ) : (
        <PrivacyEditor project={project} initial={policy} manage={manage} />
      )}
    </div>
  );
}

function PrivacyEditor({ project, initial, manage }: { project: string; initial: PrivacyPolicy; manage: boolean }) {
  const [saved, setSaved] = useState<PrivacyPolicy>(initial);
  const [draft, setDraft] = useState<PrivacyDraft>(() => draftOf(listsOf(initial)));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [status, setStatus] = useState<Status>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const defaults = useMemo(() => defaultsOf(saved), [saved]);

  const checked = checkDraft(draft);
  // Errors show as they are typed; a blank row is never one.
  const shown: DraftErrors = checked.ok ? errors : { ...checked.errors, ...errors };
  const dirty = !checked.ok || !sameLists(checked.policy, listsOf(saved));

  useEffect(() => {
    if (focus) document.getElementById(focus)?.focus();
  }, [focus]);

  const edit = (key: ListKey, rows: string[]) => {
    setDraft((d) => ({ ...d, [key]: rows }));
    setErrors({});
    setStatus(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!manage || !dirty || pending) return;
    if (!checked.ok) {
      setStatus({ tone: "err", text: "Fix the highlighted patterns to save." });
      return;
    }
    const sent = checked.policy;
    start(async () => {
      const result = await savePrivacyPolicy(project, sent);
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        if (result.row) {
          // The API counts rows of the list it received: the draft's non-blank rows, in order.
          const { key, index, reason } = result.row;
          const at = draft[key].map((r, i) => (r.trim() === "" ? -1 : i)).filter((i) => i >= 0)[index];
          if (at !== undefined) setErrors({ [key]: { [at]: `Not accepted: ${reason}.` } });
        }
        return;
      }
      setSaved(result.policy);
      setDraft(draftOf(listsOf(result.policy)));
      setErrors({});
      setStatus({ tone: "ok", text: `Saved. The ingest edge applies it within ${APPLIES_WITHIN}.` });
    });
  };

  return (
    <>
      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>You can see this policy. Only project owners, admins and members can change it.</span>
        </p>
      )}
      <form className="os-card" onSubmit={submit} aria-labelledby="prv-title" noValidate>
        <div className="os-card__head">
          <h2 id="prv-title">Server-side deny list</h2>
          <p>
            Before anything is stored, the ingest edge replaces the values of matching names with <code>{REDACTED}</code>, on top of what the SDKs already mask. Patterns
            are case-insensitive RE2 regular expressions matched against names. Saved changes apply within {APPLIES_WITHIN}.
          </p>
        </div>
        <div className="os-card__body">
          {LISTS.map((list) => (
            <PatternList
              key={list.key}
              list={list}
              builtIns={builtInRows(defaults, list.key)}
              rows={draft[list.key]}
              errors={shown[list.key] ?? {}}
              manage={manage}
              pending={pending}
              onChange={(rows) => edit(list.key, rows)}
              onAdd={() => {
                edit(list.key, [...draft[list.key], ""]);
                setFocus(`prv-${list.key}-${draft[list.key].length}`);
              }}
            />
          ))}
          <p className="prv-audit">
            {saved.updated_at ? <>Last changed {formatExact(saved.updated_at)}.</> : "Never changed: only the built-in patterns apply."}
          </p>
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
                  setDraft(draftOf(listsOf(saved)));
                  setErrors({});
                  setStatus(null);
                }}
              >
                Cancel
              </button>
            ) : null}
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || pending}>
              Save
            </button>
          </div>
        ) : null}
      </form>
      <Tester defaults={defaults} draft={draft} hasErrors={!checked.ok} />
    </>
  );
}

/** The locked groups of a list: its built-in patterns and, for headers, the exact names. */
function builtInRows(defaults: RedactorDefaults, key: ListKey): { caption: string; items: readonly string[] }[] {
  const patterns = { caption: "Built in, always applied", items: defaults[key] };
  if (key !== "mask_headers") return [patterns];
  return [patterns, { caption: "Always masked, by exact name", items: defaults.sensitive_headers }];
}

interface PatternListProps {
  list: (typeof LISTS)[number];
  builtIns: { caption: string; items: readonly string[] }[];
  rows: string[];
  errors: Record<number, string>;
  manage: boolean;
  pending: boolean;
  onChange: (rows: string[]) => void;
  onAdd: () => void;
}

function PatternList({ list, builtIns, rows, errors, manage, pending, onChange, onAdd }: PatternListProps) {
  const titleId = `prv-${list.key}-title`;
  const full = rows.filter((r) => r.trim() !== "").length >= MAX_PATTERNS;
  return (
    <fieldset className="prv-list" aria-labelledby={titleId} aria-describedby={`${titleId}-help`}>
      <h3 id={titleId}>{list.title}</h3>
      <p id={`${titleId}-help`} className="prv-help">
        {list.help}
      </p>
      {builtIns.map((group) =>
        group.items.length > 0 ? (
          <div key={group.caption} className="prv-locked">
            <p className="prv-kind">
              <ObIcon name="lock" />
              {group.caption}
            </p>
            <ul aria-label={`${list.title}: ${group.caption.toLowerCase()}`}>
              {group.items.map((text) => (
                <li key={text}>
                  <code>{text}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      <ul className="prv-rows" aria-label={`${list.title}: this project’s patterns`}>
        {rows.map((value, i) => {
          const id = `prv-${list.key}-${i}`;
          const err = errors[i];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are plain strings that may repeat; the index is the row.
            <li key={i} className="prv-row prv-row--edit">
              <div className={`ob-in prv-in${err ? " bad" : ""}${manage ? "" : " ro"}`}>
                <input
                  id={id}
                  value={value}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={list.placeholder}
                  aria-label={`${list.title} pattern ${i + 1}`}
                  aria-invalid={err !== undefined}
                  aria-describedby={err ? `${id}-err` : undefined}
                  disabled={!manage || pending}
                  onChange={(e) => onChange(rows.map((r, j) => (j === i ? e.target.value : r)))}
                />
              </div>
              {manage ? (
                <button
                  type="button"
                  className="ah-btn ah-btn--ghost ah-btn--sm prv-remove"
                  aria-label={`Remove ${list.title.toLowerCase()} pattern ${i + 1}`}
                  disabled={pending}
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              ) : null}
              {err ? (
                <p id={`${id}-err`} className="ob-err prv-err">
                  {err}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {manage ? (
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm prv-add" disabled={pending || full} onClick={onAdd}>
          Add pattern
        </button>
      ) : rows.length === 0 ? (
        <p className="prv-none">No patterns of this project’s own.</p>
      ) : null}
      {manage && full ? <p className="os-help">This list has the most patterns allowed ({MAX_PATTERNS}).</p> : null}
    </fieldset>
  );
}

/** Masks a sample request as the edge would, with the patterns on screen. */
function Tester({ defaults, draft, hasErrors }: { defaults: RedactorDefaults; draft: PrivacyDraft; hasErrors: boolean }) {
  const [sample, setSample] = useState<Sample>(SAMPLE);
  const redactor = useMemo(() => compileRedactor(defaults, validLists(draft)), [defaults, draft]);
  const out = testSample(redactor, sample);
  const field = (key: keyof Sample, label: string, hint: string, rows: number) => (
    <div className="prv-pair">
      <label className="ob-l" htmlFor={`prv-t-${key}`}>
        {label}
        <small>{hint}</small>
      </label>
      <textarea
        id={`prv-t-${key}`}
        className="prv-textarea"
        rows={rows}
        spellCheck={false}
        value={sample[key]}
        onChange={(e) => setSample((s) => ({ ...s, [key]: e.target.value }))}
      />
      <p className="prv-out-label" id={`prv-t-${key}-out-l`}>
        As stored
      </p>
      <pre className="prv-out" aria-labelledby={`prv-t-${key}-out-l`} aria-live="polite">
        {out[key] || " "}
      </pre>
    </div>
  );
  return (
    <section className="os-card" aria-labelledby="prv-tester">
      <div className="os-card__head">
        <h2 id="prv-tester">Test a request</h2>
        <p>
          Paste a sample request to see what would be stored. It uses the patterns above, unsaved ones included, and runs in your browser: nothing is sent.
          {hasErrors ? " Patterns with errors are left out." : ""}
        </p>
      </div>
      <div className="os-card__body prv-tester">
        {field("url", "URL", "a path or full URL with its query string", 2)}
        {field("headers", "Headers", "one Name: value per line, or a JSON object", 4)}
        {field("body", "Body", "JSON, form-encoded or plain text", 7)}
      </div>
    </section>
  );
}
