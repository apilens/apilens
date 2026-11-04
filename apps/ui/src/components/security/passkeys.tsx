"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState, useTransition } from "react";
import { removePasskey, renamePasskey } from "@/app/settings/passkey-actions";
import { addPasskey } from "@/lib/auth/passkey-register";
import type { Passkey } from "@/lib/identity";
import {
  MAX_PASSKEY_NAME,
  checkPasskeyName,
  formatDay,
  formatExact,
  formatLastUsed,
  passkeySettingsError,
  passkeyVendor,
} from "@/lib/passkey-settings";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "./security.css";

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * Security → Passkeys (#341): the signed-in user's passkeys with their authenticator, when each
 * was added and last used, and whether it is synced. "Add a passkey" runs the WebAuthn
 * registration through the Route Handlers, then opens the new row's name for editing so it can
 * be named. Names are edited in place; removing asks first. `initial` is null when the list
 * could not be loaded.
 */
export function PasskeysCard({ initial }: { initial: Passkey[] | null }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>(initial ?? []);
  const [status, setStatus] = useState<Status>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // "Last used" is relative to now: computed after mount so the server render and the browser agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setStatus(null);
    setRemoving(null);
    const result = await addPasskey({});
    setAdding(false);
    if (result.ok) {
      setPasskeys((list) => [...list.filter((p) => p.id !== result.passkey.id), result.passkey]);
      setEditing(result.passkey.id);
      setStatus({ tone: "ok", text: "Passkey added. Give it a name you’ll recognise." });
      return;
    }
    const text = passkeySettingsError(result.code);
    setStatus(text ? { tone: "err", text } : null);
  };

  const renamed = (p: Passkey) => {
    setPasskeys((list) => list.map((x) => (x.id === p.id ? p : x)));
    setEditing(null);
    setStatus({ tone: "ok", text: "Name saved." });
  };

  const removed = (p: Passkey) => {
    setPasskeys((list) => list.filter((x) => x.id !== p.id));
    setRemoving(null);
    setStatus({ tone: "ok", text: `Removed ${p.name}.` });
  };

  const addButton = (primary: boolean) => (
    <button
      type="button"
      className={`ah-btn ah-btn--sm ${primary ? "ah-btn--primary" : "ah-btn--ghost pk-add"}${adding ? " is-loading" : ""}`}
      onClick={add}
      disabled={adding}
    >
      <ObIcon name="finger" />
      Add a passkey
    </button>
  );

  return (
    <section className="os-card pk" aria-labelledby="pk-title">
      <div className="os-card__head pk-head">
        <div>
          <h2 id="pk-title">Passkeys</h2>
          <p>Sign in with your fingerprint, face or device screen lock instead of an emailed code.</p>
        </div>
        {initial !== null && passkeys.length > 0 ? addButton(false) : null}
      </div>
      <div className="os-card__body pk-body">
        {initial === null ? (
          <p className="pk-load-err" role="alert">
            Couldn’t load your passkeys. Reload the page to try again.
          </p>
        ) : passkeys.length === 0 ? (
          <div className="pk-empty">
            <span className="pk-empty__ic" aria-hidden="true">
              <ObIcon name="finger" />
            </span>
            <h3>No passkeys yet</h3>
            <p>
              A passkey lives on your phone, computer or security key and is unlocked the way you unlock the device. It can’t be phished or
              reused on another site, and you won’t wait for a sign-in email.
            </p>
            {addButton(true)}
          </div>
        ) : (
          <table className="pk-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Authenticator</th>
                <th scope="col">Added</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="pk-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {passkeys.map((p) => (
                <PasskeyRow
                  key={p.id}
                  passkey={p}
                  now={now}
                  editing={editing === p.id}
                  confirming={removing === p.id}
                  onEdit={() => {
                    setEditing(p.id);
                    setRemoving(null);
                    setStatus(null);
                  }}
                  onCancelEdit={() => setEditing(null)}
                  onRenamed={renamed}
                  onConfirm={() => {
                    setRemoving(p.id);
                    setEditing(null);
                    setStatus(null);
                  }}
                  onCancelConfirm={() => setRemoving(null)}
                  onRemoved={() => removed(p)}
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
  );
}

interface RowProps {
  passkey: Passkey;
  now: number | null;
  editing: boolean;
  confirming: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onRenamed: (p: Passkey) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onRemoved: () => void;
}

function PasskeyRow(props: RowProps) {
  const { passkey: p, now, editing, confirming } = props;
  const vendor = passkeyVendor(p);
  const lastUsed = now === null ? (p.last_used_at ? formatDay(p.last_used_at) : "Never") : formatLastUsed(p.last_used_at, now);
  const renameButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);

  // Back on the Rename button once the name field closes, so keyboard focus is not lost.
  useEffect(() => {
    if (wasEditing.current && !editing) renameButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  return (
    <>
      <tr className={confirming ? "pk-row is-confirming" : "pk-row"}>
        <td className="pk-name" data-label="Name">
          {editing ? (
            <RenameForm passkey={p} onCancel={props.onCancelEdit} onRenamed={props.onRenamed} />
          ) : (
            <span className="pk-name__v">
              <b>{p.name}</b>
              {p.backup_state ? (
                <span className="pk-badge" title="Synced across your devices by your password manager or platform">
                  Synced
                </span>
              ) : null}
            </span>
          )}
        </td>
        <td data-label="Authenticator">{vendor}</td>
        <td data-label="Added">
          <time dateTime={p.created_at} title={formatExact(p.created_at)}>
            {formatDay(p.created_at)}
          </time>
        </td>
        <td data-label="Last used">
          {p.last_used_at ? (
            <time dateTime={p.last_used_at} title={formatExact(p.last_used_at)}>
              {lastUsed}
            </time>
          ) : (
            <span className="pk-muted">Never</span>
          )}
        </td>
        <td className="pk-actions">
          {editing ? null : (
            <>
              <button ref={renameButton} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={props.onEdit} aria-label={`Rename ${p.name}`}>
                Rename
              </button>
              <button
                type="button"
                className="ah-btn ah-btn--ghost ah-btn--sm pk-remove"
                onClick={props.onConfirm}
                aria-label={`Remove ${p.name}`}
                aria-expanded={confirming}
                disabled={confirming}
              >
                Remove
              </button>
            </>
          )}
        </td>
      </tr>
      {confirming ? <RemoveConfirm passkey={p} onCancel={props.onCancelConfirm} onRemoved={props.onRemoved} /> : null}
    </>
  );
}

function RenameForm({ passkey, onCancel, onRenamed }: { passkey: Passkey; onCancel: () => void; onRenamed: (p: Passkey) => void }) {
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const errId = `pk-name-err-${passkey.id}`;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkPasskeyName(name);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    if (checked.name === passkey.name) {
      onCancel();
      return;
    }
    start(async () => {
      const result = await renamePasskey(passkey.id, checked.name);
      if (result.ok) onRenamed(result.passkey);
      else setError(result.error);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <form className="pk-rename" onSubmit={submit}>
      <div className={`ob-in${error ? " bad" : ""}`}>
        <input
          ref={input}
          value={name}
          maxLength={MAX_PASSKEY_NAME + 20}
          autoComplete="off"
          spellCheck={false}
          aria-label="Passkey name"
          aria-invalid={error !== null}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="pk-rename__row">
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
          Save
        </button>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
      {error ? (
        <p id={errId} className="ob-err" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function RemoveConfirm({ passkey, onCancel, onRemoved }: { passkey: Passkey; onCancel: () => void; onRemoved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = `pk-remove-${passkey.id}`;

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  const confirm = () => {
    if (pending) return;
    start(async () => {
      const result = await removePasskey(passkey.id);
      if (result.ok) onRemoved();
      else setError(result.error);
    });
  };

  return (
    <tr className="pk-confirm-row">
      <td colSpan={5}>
        <div
          className="os-confirm pk-confirm"
          role="group"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) onCancel();
          }}
        >
          <p id={titleId}>
            <b>Remove {passkey.name}?</b> You won’t be able to sign in with it any more. The passkey stays on the device until you delete it
            there too.
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
              Remove passkey
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
