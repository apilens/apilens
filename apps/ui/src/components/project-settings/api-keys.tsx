"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { createApiKey, revokeApiKey } from "@/app/[project]/settings/actions";
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  MAX_KEY_NAME,
  SCOPES,
  STATUS_LABEL,
  checkKeyName,
  expiryFor,
  keyStatus,
  maskedKey,
  scopesLabel,
  todayUTC,
  withCreated,
} from "@/lib/api-keys";
import type { ApiKey, ApiKeyScope, CreatedApiKey } from "@/lib/identity";
import { formatDay, formatExact, formatLastUsed } from "@/lib/passkey-settings";
import { Gated } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./api-keys.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings/keys` (#350): the project's API keys (revoked ones included, newest first)
 * with their prefix, scopes, last use, creation and status. "Create API key" opens a dialog
 * (name, scopes, optional expiry) that then shows the new key once, to copy. Revoking asks
 * first. Creating and revoking are gated by `api_keys.create` / `api_keys.revoke`; the API
 * checks them again. `initial` is null when the list could not be loaded; `now` is the server's
 * clock so the first render matches.
 */
export function ApiKeysSettings({ project, projectName, initial, now }: { project: string; projectName: string; initial: ApiKey[] | null; now: number }) {
  const [keys, setKeys] = useState<ApiKey[]>(initial ?? []);
  const [status, setStatus] = useState<Status>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const created = (key: CreatedApiKey) => {
    const { key: _raw, ...listed } = key;
    setKeys((list) => withCreated(list, listed));
    setStatus({ tone: "ok", text: `Created ${key.name}.` });
  };

  const revoked = (id: string, key: ApiKey | null) => {
    setKeys((list) => list.map((k) => (k.id === id ? (key ?? { ...k, revoked_at: k.revoked_at ?? new Date().toISOString() }) : k)));
    setRevoking(null);
    const name = keys.find((k) => k.id === id)?.name ?? "the key";
    setStatus({ tone: "ok", text: `Revoked ${name}. Requests using it are rejected from now on.` });
  };

  const createButton = (primary: boolean) => (
    <Gated action="api_keys.create">
      <button
        type="button"
        className={`ah-btn ah-btn--sm ${primary ? "ah-btn--primary" : "ah-btn--ghost pk-add"}`}
        onClick={() => {
          setStatus(null);
          setRevoking(null);
          setCreating(true);
        }}
      >
        <ObIcon name="lock" />
        Create API key
      </button>
    </Gated>
  );

  return (
    <div className="os ak">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">API keys</h1>
      </header>

      <section className="os-card pk ak-card" aria-labelledby="ak-title">
        <div className="os-card__head pk-head">
          <div>
            <h2 id="ak-title">API keys</h2>
            <p>Keys let your SDK send telemetry to {projectName} and let scripts read its data. Treat them like passwords.</p>
          </div>
          {initial !== null && keys.length > 0 ? createButton(false) : null}
        </div>
        <div className="os-card__body pk-body">
          {initial === null ? (
            <p className="pk-load-err" role="alert">
              Couldn’t load the API keys. Reload the page to try again.
            </p>
          ) : keys.length === 0 ? (
            <div className="pk-empty">
              <span className="pk-empty__ic" aria-hidden="true">
                <ObIcon name="lock" />
              </span>
              <h3>No API keys yet</h3>
              <p>Create an ingest key and pass it to the SDK with your app id. The full key is shown once, when you create it.</p>
              {createButton(true)}
            </div>
          ) : (
            <table className="pk-table ak-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Scopes</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="pk-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <KeyRow
                    key={k.id}
                    apiKey={k}
                    now={now}
                    confirming={revoking === k.id}
                    onConfirm={() => {
                      setRevoking(k.id);
                      setStatus(null);
                    }}
                    onCancel={() => setRevoking(null)}
                    onRevoked={(key) => revoked(k.id, key)}
                    project={project}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className={`pk-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </p>
      </section>

      <CreateKeyDialog project={project} open={creating} onClose={() => setCreating(false)} onCreated={created} />
    </div>
  );
}

interface RowProps {
  project: string;
  apiKey: ApiKey;
  now: number;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRevoked: (key: ApiKey | null) => void;
}

function KeyRow({ project, apiKey: k, now, confirming, onConfirm, onCancel, onRevoked }: RowProps) {
  const state = keyStatus(k, now);
  const expires = k.expires_at && state === "active" ? `Expires ${formatDay(k.expires_at)}` : null;
  return (
    <>
      <tr className={`pk-row${confirming ? " is-confirming" : ""}${state === "active" ? "" : ` is-inactive is-${state}`}`}>
        <td className="pk-name" data-label="Name">
          <b className="ak-name">{k.name}</b>
        </td>
        <td data-label="Key">
          <code className="ak-prefix">{maskedKey(k.prefix)}</code>
        </td>
        <td data-label="Scopes">{scopesLabel(k.scopes)}</td>
        <td data-label="Last used">
          {k.last_used_at ? (
            <time dateTime={k.last_used_at} title={formatExact(k.last_used_at)}>
              {formatLastUsed(k.last_used_at, now)}
            </time>
          ) : (
            <span className="pk-muted">Never</span>
          )}
        </td>
        <td data-label="Created">
          <time dateTime={k.created_at} title={formatExact(k.created_at)}>
            {formatDay(k.created_at)}
          </time>
        </td>
        <td data-label="Status">
          <span className={`ak-status ak-status--${state}`} title={state === "revoked" && k.revoked_at ? `Revoked ${formatExact(k.revoked_at)}` : state === "expired" && k.expires_at ? `Expired ${formatExact(k.expires_at)}` : expires ?? undefined}>
            {STATUS_LABEL[state]}
          </span>
          {expires ? <span className="ak-expires">{expires}</span> : null}
        </td>
        <td className="pk-actions">
          {state === "revoked" ? null : (
            <Gated action="api_keys.revoke">
              <button
                type="button"
                className="ah-btn ah-btn--ghost ah-btn--sm pk-remove"
                onClick={onConfirm}
                aria-label={`Revoke ${k.name}`}
                aria-expanded={confirming}
                disabled={confirming}
              >
                Revoke
              </button>
            </Gated>
          )}
        </td>
      </tr>
      {confirming ? <RevokeConfirm project={project} apiKey={k} onCancel={onCancel} onRevoked={onRevoked} /> : null}
    </>
  );
}

function RevokeConfirm({ project, apiKey, onCancel, onRevoked }: { project: string; apiKey: ApiKey; onCancel: () => void; onRevoked: (key: ApiKey | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = `ak-revoke-${apiKey.id}`;

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  const confirm = () => {
    if (pending) return;
    start(async () => {
      const result = await revokeApiKey(project, apiKey.id);
      if (result.ok) onRevoked(result.key);
      else setError(result.error);
    });
  };

  return (
    <tr className="pk-confirm-row">
      <td colSpan={7}>
        <div
          className="os-confirm pk-confirm"
          role="group"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) onCancel();
          }}
        >
          <p id={titleId}>
            <b>Revoke {apiKey.name}?</b> Anything still using <code>{maskedKey(apiKey.prefix)}</code> is rejected within a minute. This can’t be
            undone; create a new key to replace it.
          </p>
          {error ? (
            <p className="ob-err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <button ref={cancel} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={confirm} disabled={pending}>
              Revoke key
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * A modal `<dialog>` in two steps: the form, then the new key shown once. While the key is shown
 * Escape does nothing, so it cannot be dismissed by accident before it is copied; "Done" closes.
 */
function CreateKeyDialog({ project, open, onClose, onCreated }: { project: string; open: boolean; onClose: () => void; onCreated: (key: CreatedApiKey) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => {
    setRevealed(null);
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="ak-dialog"
      aria-labelledby="ak-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!revealed) close();
      }}
      onClose={() => {
        if (open) close();
      }}
    >
      {!open ? null : revealed ? (
        <RevealKey apiKey={revealed} onDone={close} />
      ) : (
        <CreateForm
          project={project}
          onCancel={close}
          onCreated={(key) => {
            setRevealed(key);
            onCreated(key);
          }}
        />
      )}
    </dialog>
  );
}

function CreateForm({ project, onCancel, onCreated }: { project: string; onCancel: () => void; onCreated: (key: CreatedApiKey) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["ingest"]);
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [date, setDate] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const toggleScope = (scope: ApiKeyScope) => {
    setScopes((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]));
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkKeyName(name);
    if (!checked.ok) {
      setNameError(checked.error);
      input.current?.focus();
      return;
    }
    if (scopes.length === 0) {
      setError("Choose what the key may do.");
      return;
    }
    const when = expiryFor(expiry, date);
    if (!when.ok) {
      setError(when.error);
      return;
    }
    start(async () => {
      const result = await createApiKey(project, { name: checked.name, scopes, expiresAt: when.expiresAt });
      if (result.ok) onCreated(result.key);
      else setError(result.error);
    });
  };

  return (
    <form className="ak-form" onSubmit={submit} noValidate>
      <div className="ak-dialog__head">
        <h2 id="ak-dialog-title">Create API key</h2>
        <p>The full key is shown once, right after you create it.</p>
      </div>
      <div className="ak-dialog__body">
        <div className="ob-f">
          <label className="ob-l" htmlFor="ak-name">
            Name<small>so you can tell keys apart</small>
          </label>
          <div className={`ob-in${nameError ? " bad" : ""}`}>
            <input
              ref={input}
              id="ak-name"
              value={name}
              placeholder="Production backend"
              maxLength={MAX_KEY_NAME + 20}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? "ak-name-err" : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
                setError(null);
              }}
            />
          </div>
          {nameError ? (
            <p id="ak-name-err" className="ob-err">
              {nameError}
            </p>
          ) : null}
        </div>

        <fieldset className="ob-f ak-scopes">
          <legend className="ob-l">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s.value} className={`ak-scope${scopes.includes(s.value) ? " on" : ""}`}>
              <input type="checkbox" checked={scopes.includes(s.value)} onChange={() => toggleScope(s.value)} />
              <span>
                <b>{s.label}</b>
                <span>{s.help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="ob-f">
          <label className="ob-l" htmlFor="ak-expiry">
            Expires<small>optional</small>
          </label>
          <div className="ak-expiry">
            <div className="ob-in">
              <select
                id="ak-expiry"
                value={expiry}
                onChange={(e) => {
                  setExpiry(e.target.value as ExpiryChoice);
                  setError(null);
                }}
              >
                {EXPIRY_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {expiry === "custom" ? (
              <div className="ob-in">
                <input
                  type="date"
                  aria-label="Expiry date"
                  value={date}
                  min={todayUTC(Date.now() + 86_400_000)}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setError(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="ak-dialog__foot">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
          Create key
        </button>
      </div>
    </form>
  );
}

function RevealKey({ apiKey, onDone }: { apiKey: CreatedApiKey; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    copyButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.key);
      setCopied(true);
      setCopyError(false);
    } catch {
      field.current?.select();
      setCopyError(true);
    }
  };

  return (
    <div className="ak-reveal">
      <div className="ak-dialog__head">
        <h2 id="ak-dialog-title">Copy your new key</h2>
        <p>
          <b>{apiKey.name}</b> · {scopesLabel(apiKey.scopes)}
          {apiKey.expires_at ? ` · expires ${formatDay(apiKey.expires_at)}` : ""}
        </p>
      </div>
      <div className="ak-dialog__body">
        <p className="os-note ak-warn">
          <ObIcon name="info" />
          <span>This is the only time the full key is shown. Store it somewhere safe, like your secret manager, before you close this.</span>
        </p>
        <div className="ob-f">
          <label className="ob-l" htmlFor="ak-key">
            API key
          </label>
          <div className="ob-in ro ak-key">
            <input ref={field} id="ak-key" value={apiKey.key} readOnly spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
            <button ref={copyButton} type="button" className="ah-btn ah-btn--ghost ah-btn--sm os-copy" onClick={copy} aria-label="Copy API key">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="ak-copied" role="status" aria-live="polite">
            {copied ? "Copied to the clipboard." : copyError ? "Couldn’t copy. The key is selected: copy it with your keyboard." : ""}
          </p>
        </div>
      </div>
      <div className="ak-dialog__foot">
        <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
