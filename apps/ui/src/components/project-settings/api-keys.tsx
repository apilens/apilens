"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { createApiKey, revokeApiKey, updateApiKeyAccess } from "@/app/[project]/settings/actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useReauth } from "@/components/reauth-dialog";
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  INACTIVE_PARAM,
  KEYS_PAGE,
  KEYS_READ_ONLY,
  type KeyAccess,
  type KeyFilter,
  MAX_KEY_NAME,
  SCOPES,
  STATE_FILTERS,
  STATE_LABEL,
  STATE_PARAM,
  type StateFilter,
  abilitiesText,
  accessOf,
  checkKeyName,
  expiryFor,
  filterKeys,
  inactiveCount,
  isInactive,
  isIngestKey,
  keyState,
  keyStateLabel,
  keysPath,
  limitsText,
  maskedKey,
  parseKeyFilter,
  permissionSummary,
  relativeTime,
  revealAppHint,
  revealSnippet,
  scopesLabel,
  sdkText,
  todayUTC,
  withCreated,
} from "@/lib/api-keys";
import { activeApps } from "@/lib/app-manage";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import type { ApiKey, ApiKeyScope, CreatedApiKey, ManagedApp } from "@/lib/identity";
import { type SearchParams, hrefWithoutPage, parsePage, slicePage } from "@/lib/pagination";
import { formatDay, formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { projectSectionHref } from "@/lib/project-settings";
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

/**
 * Access › API keys, `/<project>/access/keys` (#350, moved in #801, columns in #810): the project's
 * API keys, newest first, with their name, prefix, what they can do (ingest, create apps, read,
 * and their app and environment limits in words), who created them and when, last use (relative,
 * with the SDK and version, the exact time on hover), expiry and state (Active, Expires in 5 days,
 * Rotating until 14 Nov, Expired, Revoked). The list filters by state in the URL (`?state=`);
 * expired and revoked keys are behind "Show inactive" (`?inactive=1`); it pages in the URL.
 * "Create API key" opens a dialog (name, scopes, app access, optional expiry) that then shows the
 * new key once, to copy; afterwards only the prefix is ever shown. "Edit access" changes an ingest
 * key's app access; "Revoke" opens the shared confirmation dialog, which asks for the key's name.
 * Holders of `api_keys.create` / `api_keys.revoke` see the controls; everyone else reads the list
 * with a line saying why. The API checks again. `initial` is null when the list could not be
 * loaded, `apps` when the project's apps could not; `now` is the server's clock so the first render
 * matches; `nav` is the Access page's tabs, shown under the title.
 */
export function ApiKeysSettings({
  project,
  projectName,
  initial,
  apps,
  params,
  now,
  nav,
}: {
  project: string;
  projectName: string;
  initial: ApiKey[] | null;
  apps: ManagedApp[] | null;
  params: SearchParams;
  now: number;
  nav?: ReactNode;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState<ApiKey[]>(initial ?? []);
  const [status, setStatus] = useState<Status>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const canCreate = useCan("api_keys.create").allowed;
  const canRevoke = useCan("api_keys.revoke").allowed;
  const readOnly = !canCreate && !canRevoke;
  const filterId = useId();

  const info = useMemo<AppsInfo>(
    () => ({
      pickable: apps ? activeApps(apps) : null,
      names: new Map((apps ?? []).map((a) => [a.id, a.name])),
      slugs: new Map((apps ?? []).map((a) => [a.id, a.slug])),
    }),
    [apps],
  );

  // The filter follows the URL; a change shows at once and the URL catches up.
  const urlFilter = parseKeyFilter(params);
  const [filter, setFilterState] = useState<KeyFilter>(urlFilter);
  useEffect(() => {
    setFilterState({ state: urlFilter.state, inactive: urlFilter.inactive });
  }, [urlFilter.state, urlFilter.inactive]);
  const shown = filterKeys(keys, filter, now);
  const hidden = inactiveCount(keys, now);
  const settled = filter.state === urlFilter.state && filter.inactive === urlFilter.inactive;
  const { rows, window: w } = slicePage(shown, parsePage(settled ? params : {}, KEYS_PAGE));

  // A filter change starts again at page 1; hiding inactive keys drops an Expired or Revoked filter.
  const setFilter = (next: KeyFilter) => {
    const state = next.state !== "all" && !next.inactive && isInactive(next.state) ? "all" : next.state;
    setFilterState({ state, inactive: next.inactive });
    const href = hrefWithoutPage(keysPath(project), params, { [STATE_PARAM]: state === "all" ? null : state, [INACTIVE_PARAM]: next.inactive ? "1" : null });
    router.replace(href, { scroll: false });
  };

  const created = (key: CreatedApiKey) => {
    const { key: _raw, ...listed } = key;
    setKeys((list) => withCreated(list, listed));
    setStatus({ tone: "ok", text: `Created ${key.name}.` });
  };

  const revoked = (id: string, key: ApiKey | null) => {
    setKeys((list) => list.map((k) => (k.id === id ? (key ?? { ...k, revoked_at: k.revoked_at ?? new Date().toISOString() }) : k)));
    const name = keys.find((k) => k.id === id)?.name ?? "the key";
    setRevoking(null);
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
          setCreating(true);
        }}
      >
        <ObIcon name="lock" />
        Create API key
      </button>
    ) : null;

  const stateChoices = STATE_FILTERS.filter((s) => s === "all" || filter.inactive || !isInactive(s));

  return (
    <div className="page os ak">
      <header className="os-head">
        <p className="cp-h">{projectName} · Access</p>
        <h1 className="cp-lede">API keys</h1>
        {nav}
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
              <p>
                Create an ingest key and give it to your SDK with an app name. The app appears on its own when the first data arrives. The full key is shown once, when you
                create it.
              </p>
              <p className="ak-empty-link">
                <Link href={projectSectionHref(project, { slug: "sdk" })}>Set up the SDK</Link>
              </p>
              {createButton(true)}
            </div>
          ) : (
            <>
              <div className="ak-tools" role="group" aria-label="Filter keys">
                <label className="ak-tools__state" htmlFor={filterId}>
                  State
                </label>
                <span className="ob-in ak-tools__select">
                  <select id={filterId} value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value as StateFilter })}>
                    {stateChoices.map((s) => (
                      <option key={s} value={s}>
                        {s === "all" ? "All states" : STATE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </span>
                <label className="ak-tools__inactive">
                  <input type="checkbox" checked={filter.inactive} onChange={(e) => setFilter({ ...filter, inactive: e.target.checked })} />
                  <span>Show inactive ({hidden})</span>
                </label>
              </div>
              {shown.length === 0 ? (
                <p className="ak-none">
                  {filter.state === "all" ? "Every key is expired or revoked. Turn on “Show inactive” to see them." : `No ${STATE_LABEL[filter.state].toLowerCase()} keys.`}
                </p>
              ) : (
                <table className="pk-table ak-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Key</th>
                      <th scope="col">Can</th>
                      <th scope="col">Created</th>
                      <th scope="col">Last used</th>
                      <th scope="col">Expires</th>
                      <th scope="col">State</th>
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
                        onEdit={() => {
                          setStatus(null);
                          setEditing(k);
                        }}
                        onRevoke={() => {
                          setStatus(null);
                          setRevoking(k);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              )}
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
      {canRevoke ? <RevokeDialog project={project} apiKey={revoking} onCancel={() => setRevoking(null)} onRevoked={revoked} /> : null}
    </div>
  );
}

interface RowProps {
  apiKey: ApiKey;
  info: AppsInfo;
  now: number;
  canEdit: boolean;
  canRevoke: boolean;
  onEdit: () => void;
  onRevoke: () => void;
}

function KeyRow({ apiKey: k, info, now, canEdit, canRevoke, onEdit, onRevoke }: RowProps) {
  const state = keyState(k, now);
  const ingest = isIngestKey(k);
  const limits = limitsText(k, info.names);
  const sdk = sdkText(k.last_used_sdk);
  const stateTitle =
    state === "revoked" && k.revoked_at
      ? `Revoked ${formatExact(k.revoked_at)}`
      : k.expires_at && state !== "active"
        ? `${state === "expired" ? "Expired" : "Stops working"} ${formatExact(k.expires_at)}`
        : undefined;
  return (
    <tr className={`pk-row${isInactive(state) ? ` is-inactive is-${state}` : ""}`}>
      <td className="pk-name" data-label="Name">
        <b className="ak-name">{k.name}</b>
      </td>
      <td data-label="Key">
        <code className="ak-prefix">{maskedKey(k.prefix)}</code>
      </td>
      <td data-label="Can" className="ak-can">
        <div>
          <span>{abilitiesText(k)}</span>
          {limits ? <span className="ak-sub">{limits}</span> : null}
        </div>
      </td>
      <td data-label="Created">
        <div>
          <time dateTime={k.created_at} title={formatExact(k.created_at)}>
            {formatDay(k.created_at)}
          </time>
          {k.created_by ? <span className="ak-sub">by {k.created_by.name}</span> : null}
        </div>
      </td>
      <td data-label="Last used">
        {k.last_used_at ? (
          <div>
            <time dateTime={k.last_used_at} title={formatExact(k.last_used_at)}>
              {relativeTime(k.last_used_at, now)}
            </time>
            {sdk ? <span className="ak-sub">{sdk}</span> : null}
          </div>
        ) : (
          <span className="pk-muted">Never</span>
        )}
      </td>
      <td data-label="Expires">
        {k.expires_at ? (
          <time dateTime={k.expires_at} title={formatExact(k.expires_at)}>
            {formatDay(k.expires_at)}
          </time>
        ) : (
          <span className="pk-muted">Never</span>
        )}
      </td>
      <td data-label="State">
        <span className={`ak-status ak-status--${state}`} title={stateTitle}>
          {keyStateLabel(k, now)}
        </span>
      </td>
      <td className="pk-actions">
        {state === "revoked" ? null : (
          <span className="ak-actions">
            {canEdit && ingest && state !== "expired" ? (
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onEdit} aria-label={`Edit access of ${k.name}`} aria-haspopup="dialog">
                Edit access
              </button>
            ) : null}
            {canRevoke ? (
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm pk-remove" onClick={onRevoke} aria-label={`Revoke ${k.name}`} aria-haspopup="dialog">
                Revoke
              </button>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

/** Revoking asks for the key's name in the shared confirmation dialog (#802); focus starts on Cancel. */
function RevokeDialog({ project, apiKey, onCancel, onRevoked }: { project: string; apiKey: ApiKey | null; onCancel: () => void; onRevoked: (id: string, key: ApiKey | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () => {
    if (!apiKey || pending) return;
    start(async () => {
      const result = await revokeApiKey(project, apiKey.id);
      if (result.ok) {
        setError(null);
        onRevoked(apiKey.id, result.key);
      } else setError(result.error);
    });
  };

  return (
    <ConfirmDialog
      open={apiKey !== null}
      title={`Revoke ${apiKey?.name ?? "this key"}?`}
      phrase={apiKey?.name ?? ""}
      actionLabel="Revoke key"
      pending={pending}
      error={error}
      onConfirm={confirm}
      onCancel={() => {
        setError(null);
        onCancel();
      }}
    >
      <p>
        Anything still using <code>{apiKey ? maskedKey(apiKey.prefix) : ""}</code> is rejected within a minute. This can’t be undone; create a new key to replace it.
      </p>
    </ConfirmDialog>
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
