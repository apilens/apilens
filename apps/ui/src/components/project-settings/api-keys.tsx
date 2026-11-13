"use client";

import { type FormEvent, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { createApiKey, revokeApiKey, updateApiKeyAccess } from "@/app/[project]/settings/actions";
import { useReauth } from "@/components/reauth-dialog";
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  KEYS_PAGE,
  KEYS_READ_ONLY,
  type KeyAccess,
  MAX_KEY_NAME,
  SCOPES,
  STATUS_LABEL,
  accessOf,
  appScopeText,
  appsSeen,
  checkKeyName,
  expiryFor,
  isIngestKey,
  keyStatus,
  keysPath,
  maskedKey,
  permissionSummary,
  revealAppHint,
  revealSnippet,
  scopesLabel,
  todayUTC,
  withCreated,
} from "@/lib/api-keys";
import { activeApps } from "@/lib/app-manage";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import type { ApiKey, ApiKeyScope, CreatedApiKey, ManagedApp } from "@/lib/identity";
import { type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { formatDay, formatExact, formatLastUsed } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import { AccessFields } from "./access-fields";
import { Pagination } from "../pagination/pagination";
import "../org-settings/org-settings.css";
import "../security/security.css";
import "./api-keys.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/** The project's apps as the keys page uses them: names for ids, and the ones a key can be limited to. */
interface AppsInfo {
  /** null when the project's apps could not be read. */
  pickable: ManagedApp[] | null;
  names: ReadonlyMap<string, string>;
  slugs: ReadonlyMap<string, string>;
}

/** How many apps a key has sent data for are listed in its row. */
const SEEN_SHOWN = 3;

/**
 * `/<project>/settings/keys` (#350): the project's API keys (revoked ones included, newest first)
 * with their prefix, permissions (scopes, and for ingest keys whether their data creates apps or
 * which apps they are limited to), the apps they have sent data for, last use and status, paged in
 * the URL. "Create API key" opens a dialog (name, scopes, app access, optional expiry) that then
 * shows the new key once, to copy. "Edit access" changes an ingest key's app access; revoking asks
 * first. Owners, admins and members (`api_keys.create` / `api_keys.revoke`) see the controls;
 * everyone else reads the list with a line saying why. The API checks again. `initial` is null when
 * the list could not be loaded, `apps` when the project's apps could not; `now` is the server's
 * clock so the first render matches.
 */
export function ApiKeysSettings({
  project,
  projectName,
  initial,
  apps,
  params,
  now,
}: {
  project: string;
  projectName: string;
  initial: ApiKey[] | null;
  apps: ManagedApp[] | null;
  params: SearchParams;
  now: number;
}) {
  const [keys, setKeys] = useState<ApiKey[]>(initial ?? []);
  const [status, setStatus] = useState<Status>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const canCreate = useCan("api_keys.create").allowed;
  const canRevoke = useCan("api_keys.revoke").allowed;
  const readOnly = !canCreate && !canRevoke;

  const info = useMemo<AppsInfo>(
    () => ({
      pickable: apps ? activeApps(apps) : null,
      names: new Map((apps ?? []).map((a) => [a.id, a.name])),
      slugs: new Map((apps ?? []).map((a) => [a.id, a.slug])),
    }),
    [apps],
  );

  const { rows, window: w } = slicePage(keys, parsePage(params, KEYS_PAGE));

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

  const saved = (key: ApiKey) => {
    setKeys((list) => list.map((k) => (k.id === key.id ? key : k)));
    setEditing(null);
    setStatus({ tone: "ok", text: `Updated ${key.name}: ${permissionSummary(key)}.` });
  };

  const createButton = (primary: boolean) =>
    canCreate ? (
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
    ) : null;

  return (
    <div className="page os ak">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">API keys</h1>
      </header>

      <section className="os-card pk ak-card" aria-labelledby="ak-title">
        <div className="os-card__head pk-head">
          <div>
            <h2 id="ak-title">API keys</h2>
            <p>
              Keys let your SDK send telemetry to {projectName} and let scripts read its data. Treat them like passwords. The app name your SDK sends picks the
              app; with “Can create apps”, a new name creates the app.
            </p>
          </div>
          {initial !== null && keys.length > 0 ? createButton(false) : null}
        </div>
        <div className="os-card__body pk-body">
          {readOnly && initial !== null ? (
            <p className="os-note ak-readonly">
              <ObIcon name="info" />
              <span>{KEYS_READ_ONLY}</span>
            </p>
          ) : null}
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
              <p>Create an ingest key and give it to your SDK with an app name. The app appears on its own when the first data arrives. The full key is shown once, when you create it.</p>
              {createButton(true)}
            </div>
          ) : (
            <>
              <table className="pk-table ak-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Key</th>
                    <th scope="col">Permissions</th>
                    <th scope="col">Apps</th>
                    <th scope="col">Last used</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="pk-sr">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((k) => (
                    <KeyRow
                      key={k.id}
                      apiKey={k}
                      info={info}
                      now={now}
                      canEdit={canCreate}
                      canRevoke={canRevoke}
                      confirming={revoking === k.id}
                      onEdit={() => {
                        setStatus(null);
                        setRevoking(null);
                        setEditing(k);
                      }}
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
              <Pagination pathname={keysPath(project)} params={params} total={w.total} {...KEYS_PAGE} label="API key pages" />
            </>
          )}
        </div>
        <p className={`pk-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </p>
      </section>

      {canCreate ? <CreateKeyDialog project={project} info={info} open={creating} onClose={() => setCreating(false)} onCreated={created} /> : null}
      {editing ? <AccessDialog project={project} apiKey={editing} info={info} onClose={() => setEditing(null)} onSaved={saved} /> : null}
    </div>
  );
}

interface RowProps {
  project: string;
  apiKey: ApiKey;
  info: AppsInfo;
  now: number;
  canEdit: boolean;
  canRevoke: boolean;
  confirming: boolean;
  onEdit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRevoked: (key: ApiKey | null) => void;
}

function KeyRow({ project, apiKey: k, info, now, canEdit, canRevoke, confirming, onEdit, onConfirm, onCancel, onRevoked }: RowProps) {
  const state = keyStatus(k, now);
  const expires = k.expires_at && state === "active" ? `Expires ${formatDay(k.expires_at)}` : null;
  const ingest = isIngestKey(k);
  const seen = appsSeen(k);
  const scope = appScopeText(k, info.names);
  return (
    <>
      <tr className={`pk-row${confirming ? " is-confirming" : ""}${state === "active" ? "" : ` is-inactive is-${state}`}`}>
        <td className="pk-name" data-label="Name">
          <b className="ak-name">{k.name}</b>
          <span className="ak-sub">
            Created{" "}
            <time dateTime={k.created_at} title={formatExact(k.created_at)}>
              {formatDay(k.created_at)}
            </time>
          </span>
        </td>
        <td data-label="Key">
          <code className="ak-prefix">{maskedKey(k.prefix)}</code>
        </td>
        <td data-label="Permissions">{permissionSummary(k)}</td>
        <td data-label="Apps" className="ak-apps">
          {ingest ? (
            <div>
              <span className="ak-scope-text">{scope}</span>
              {seen.length === 0 ? (
                <span className="ak-sub">No data sent yet</span>
              ) : (
                <ul className="ak-seen" aria-label={`Apps ${k.name} has sent data for`}>
                  {seen.slice(0, SEEN_SHOWN).map((a) => (
                    <li key={a.app_id}>
                      {a.name}{" "}
                      <time dateTime={a.last_seen_at} title={`Last data ${formatExact(a.last_seen_at)}`}>
                        · {formatLastUsed(a.last_seen_at, now).toLowerCase()}
                      </time>
                    </li>
                  ))}
                  {seen.length > SEEN_SHOWN ? <li className="ak-sub">and {seen.length - SEEN_SHOWN} more</li> : null}
                </ul>
              )}
            </div>
          ) : (
            <span className="pk-muted">Doesn’t send data</span>
          )}
        </td>
        <td data-label="Last used">
          {k.last_used_at ? (
            <time dateTime={k.last_used_at} title={formatExact(k.last_used_at)}>
              {formatLastUsed(k.last_used_at, now)}
            </time>
          ) : (
            <span className="pk-muted">Never</span>
          )}
        </td>
        <td data-label="Status">
          <span
            className={`ak-status ak-status--${state}`}
            title={state === "revoked" && k.revoked_at ? `Revoked ${formatExact(k.revoked_at)}` : state === "expired" && k.expires_at ? `Expired ${formatExact(k.expires_at)}` : (expires ?? undefined)}
          >
            {STATUS_LABEL[state]}
          </span>
          {expires ? <span className="ak-expires">{expires}</span> : null}
        </td>
        <td className="pk-actions">
          {state === "revoked" ? null : (
            <span className="ak-actions">
              {canEdit && ingest ? (
                <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onEdit} aria-label={`Edit access of ${k.name}`} aria-haspopup="dialog">
                  Edit access
                </button>
              ) : null}
              {canRevoke ? (
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
              ) : null}
            </span>
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

/** The access a dialog can submit, or why not. */
function accessProblem(a: KeyAccess): string | null {
  return a.appIds !== null && a.appIds.length === 0 ? "Choose at least one app, or allow all apps." : null;
}

/**
 * A modal `<dialog>` in two steps: the form, then the new key shown once. While the key is shown
 * Escape does nothing, so it cannot be dismissed by accident before it is copied; "Done" closes.
 */
function CreateKeyDialog({ project, info, open, onClose, onCreated }: { project: string; info: AppsInfo; open: boolean; onClose: () => void; onCreated: (key: CreatedApiKey) => void }) {
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
        <RevealKey apiKey={revealed} slugs={info.slugs} onDone={close} />
      ) : (
        <CreateForm
          project={project}
          pickable={info.pickable}
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

function CreateForm({ project, pickable, onCancel, onCreated }: { project: string; pickable: ManagedApp[] | null; onCancel: () => void; onCreated: (key: CreatedApiKey) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["ingest"]);
  const [access, setAccess] = useState<KeyAccess>({ canCreateApps: true, appIds: null });
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [date, setDate] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  // Creating a key needs a recent sign-in (D12): reauth_required opens the dialog, then retries once.
  const { withReauth, dialog: reauthDialog } = useReauth();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const toggleScope = (scope: ApiKeyScope) => {
    setScopes((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]));
    setError(null);
  };

  const ingest = scopes.includes("ingest");

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
    const problem = ingest ? accessProblem(access) : null;
    if (problem) {
      setError(problem);
      return;
    }
    const when = expiryFor(expiry, date);
    if (!when.ok) {
      setError(when.error);
      return;
    }
    start(async () => {
      const result = await withReauth(() =>
        createApiKey(project, {
          name: checked.name,
          scopes,
          expiresAt: when.expiresAt,
          ...(ingest ? { canCreateApps: access.appIds === null ? access.canCreateApps : false, appIds: access.appIds } : {}),
        }),
      );
      if (result.ok) onCreated(result.key);
      else if (result.code !== REAUTH_CANCELLED) setError(result.error);
    });
  };

  return (
    <>
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

          {ingest ? (
            <AccessFields
              value={access}
              pickable={pickable}
              onChange={(next) => {
                setAccess(next);
                setError(null);
              }}
            />
          ) : null}

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
      {reauthDialog}
    </>
  );
}

/** Copies `text`, answering whether it worked (the clipboard can be blocked). */
function useCopy(): [copied: boolean, failed: boolean, copy: (text: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };
  return [copied, failed, copy];
}

function RevealKey({ apiKey, slugs, onDone }: { apiKey: CreatedApiKey; slugs: ReadonlyMap<string, string>; onDone: () => void }) {
  const [copied, copyError, copy] = useCopy();
  const [snippetCopied, snippetError, copySnippet] = useCopy();
  const field = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const access = accessOf(apiKey);
  const ingest = isIngestKey(apiKey);
  const snippet = revealSnippet(apiKey.key, access, slugs);

  useEffect(() => {
    copyButton.current?.focus();
  }, []);

  return (
    <div className="ak-reveal">
      <div className="ak-dialog__head">
        <h2 id="ak-dialog-title">Copy your new key</h2>
        <p>
          <b>{apiKey.name}</b> · {ingest ? permissionSummary(apiKey) : scopesLabel(apiKey.scopes)}
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
            <button
              ref={copyButton}
              type="button"
              className="ah-btn ah-btn--ghost ah-btn--sm os-copy"
              onClick={async () => {
                if (!(await copy(apiKey.key))) field.current?.select();
              }}
              aria-label="Copy API key"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="ak-copied" role="status" aria-live="polite">
            {copied ? "Copied to the clipboard." : copyError ? "Couldn’t copy. The key is selected: copy it with your keyboard." : ""}
          </p>
        </div>
        {ingest ? (
          <div className="ob-f">
            <div className="ak-snippet__head">
              <p className="ob-l" id="ak-env-label">
                Environment for your service
              </p>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm os-copy" onClick={() => copySnippet(snippet)} aria-label="Copy environment">
                {snippetCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="ak-snippet" tabIndex={0} aria-labelledby="ak-env-label">
              {snippet}
            </pre>
            <p className="ak-hint">{revealAppHint(access)}</p>
            {snippetError ? (
              <p className="ak-copied" role="alert">
                Couldn’t copy. Select the lines and copy them with your keyboard.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="ak-dialog__foot">
        <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** "Edit access": a modal to change an ingest key's app access (`PUT .../access`). Escape cancels. */
function AccessDialog({ project, apiKey, info, onClose, onSaved }: { project: string; apiKey: ApiKey; info: AppsInfo; onClose: () => void; onSaved: (key: ApiKey) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [access, setAccess] = useState<KeyAccess>(() => accessOf(apiKey));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const titleId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const problem = accessProblem(access);
    if (problem) {
      setError(problem);
      return;
    }
    start(async () => {
      const result = await updateApiKeyAccess(project, apiKey.id, access);
      if (result.ok) onSaved(result.key);
      else setError(result.error);
    });
  };

  return (
    <dialog
      ref={dialog}
      className="ak-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <form className="ak-form" onSubmit={submit} noValidate>
        <div className="ak-dialog__head">
          <h2 id={titleId}>Edit access of {apiKey.name}</h2>
          <p>
            <code>{maskedKey(apiKey.prefix)}</code> · changes apply to the next data the key sends, within a minute.
          </p>
        </div>
        <div className="ak-dialog__body">
          <AccessFields
            value={access}
            pickable={info.pickable}
            disabled={pending}
            onChange={(next) => {
              setAccess(next);
              setError(null);
            }}
          />
          {error ? (
            <p className="ob-err" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="ak-dialog__foot">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
            Save access
          </button>
        </div>
      </form>
    </dialog>
  );
}
