"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { deleteAccount } from "@/app/settings/profile-actions";
import { type OwnedOrg, deleteConfirmed } from "@/lib/profile";
import { forgetAccount } from "@/lib/remembered-account";
import "../org-settings/org-settings.css";
import "./account.css";

/**
 * `/settings/danger` (#340): deleting the account, after a confirmation that repeats its email.
 * The API refuses with `owner_transfer_required` while the user is the only owner of an
 * organization; the organizations they own are then listed with links to settle them first.
 */
export function DeleteAccount({ email, owned }: { email: string; owned: OwnedOrg[] }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [pending, start] = useTransition();
  const field = useRef<HTMLInputElement>(null);
  const confirmed = deleteConfirmed(email, typed);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!confirmed || pending) return;
    start(async () => {
      const result = await deleteAccount(typed);
      if (result.ok) {
        // Every session is gone with the account; a full navigation drops the signed-in UI.
        forgetAccount();
        window.location.assign(result.next);
        return;
      }
      if (result.code === "owner_transfer_required") {
        setBlocked(true);
        close();
        return;
      }
      setError(result.error);
    });
  };

  return (
    <div className="os acct-os">
      <section className="os-card os-card--danger" aria-labelledby="ac-danger">
        <div className="os-card__head">
          <h2 id="ac-danger">Delete account</h2>
        </div>
        <div className="os-card__body">
          <div className="os-danger">
            <p className="t">
              <b>Delete your APILens account</b>
              You’re signed out everywhere at once. The account and {email} are removed for good after 30 days; until then, it can still be restored.
            </p>
            {open ? null : (
              <button
                type="button"
                className="ah-btn ah-btn--sm os-btn-outline-danger"
                onClick={() => {
                  setBlocked(false);
                  setOpen(true);
                }}
              >
                Delete account
              </button>
            )}
          </div>

          {blocked ? <OwnerTransferRequired owned={owned} /> : null}

          {open ? (
            <form className="os-confirm" onSubmit={submit}>
              <p>
                <label htmlFor="ac-delete-confirm">
                  To confirm, type <code>{email}</code> below.
                </label>
              </p>
              <div className={`ob-in${error ? " bad" : ""}`}>
                <input
                  ref={field}
                  id="ac-delete-confirm"
                  type="email"
                  value={typed}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") close();
                  }}
                  aria-invalid={error !== null}
                  aria-describedby={error ? "ac-delete-err" : undefined}
                />
              </div>
              {error ? (
                <p id="ac-delete-err" className="ob-err" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="row">
                <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
                  Cancel
                </button>
                <button type="submit" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} disabled={!confirmed || pending}>
                  Delete my account
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function OwnerTransferRequired({ owned }: { owned: OwnedOrg[] }) {
  return (
    <div className="ac-blocked" role="alert">
      <p>
        <b>Your account wasn’t deleted.</b> You’re the only owner of {owned.length === 1 ? "an organization" : "at least one organization"}, and an organization can’t
        be left without an owner. Make another member an owner, or delete the organization, then try again.
      </p>
      {owned.length ? (
        <ul>
          {owned.map((o) => (
            <li key={o.slug}>
              <Link href={o.href}>{o.name}</Link>
              <span>{o.slug}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
