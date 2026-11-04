"use client";

import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { type ProfileResult, confirmEmailChange, requestEmailChange, saveProfileName } from "@/app/settings/profile-actions";
import type { User } from "@/lib/identity";
import { CODE_LENGTH, MAX_NAME, checkName, checkNewEmail, cleanCode, isCode } from "@/lib/profile";
import { readRememberedAccount, rememberAccount } from "@/lib/remembered-account";
import { userLabel } from "@/lib/scope";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/org-settings.css";
import "./account.css";

type Status = { tone: "ok" | "err"; text: string } | null;

function StatusLine({ status, id }: { status: Status; id: string }) {
  return (
    <span id={id} className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
      {status?.text ?? ""}
    </span>
  );
}

/**
 * `/settings` Profile (#340): the display name (with the initials the avatar shows) and the email
 * address, which changes only after a code sent to the new address is confirmed.
 */
export function ProfileSettings({ user }: { user: Pick<User, "name" | "email"> }) {
  const [email, setEmail] = useState(user.email);
  return (
    <div className="os acct-os">
      <NameCard initial={user.name ?? ""} email={email} />
      <EmailCard email={email} onChanged={setEmail} />
    </div>
  );
}

function NameCard({ initial, email }: { initial: string; email: string }) {
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const checked = checkName(name);
  const dirty = name.trim() !== saved;
  const invalid = dirty && !checked.ok;
  const me = userLabel({ name: name.trim() || saved, email });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !checked.ok || pending) return;
    start(async () => {
      const result: ProfileResult = await saveProfileName(checked.name);
      if (result.ok) {
        const next = result.user.name ?? checked.name;
        setSaved(next);
        setName(next);
        setStatus({ tone: "ok", text: "Name saved." });
      } else {
        setStatus({ tone: "err", text: result.error });
      }
    });
  };

  return (
    <form className="os-card" onSubmit={submit} aria-labelledby="ac-profile">
      <div className="os-card__head">
        <h2 id="ac-profile">Name</h2>
        <p>How you appear to the people in your organizations. Your avatar shows your initials.</p>
      </div>
      <div className="os-card__body">
        <div className="ac-who">
          <span className="ac-avatar" aria-hidden="true">
            {me.initials}
          </span>
          <div className="ob-f">
            <label className="ob-l" htmlFor="ac-name">
              Full name
            </label>
            <div className={`ob-in${invalid ? " bad" : ""}`}>
              <ObIcon name="user" />
              <input
                id="ac-name"
                name="name"
                autoComplete="name"
                maxLength={MAX_NAME + 20}
                value={name}
                placeholder="Your name"
                onChange={(e) => {
                  setName(e.target.value);
                  setStatus(null);
                }}
                aria-invalid={invalid}
                aria-describedby={invalid ? "ac-name-err" : undefined}
              />
            </div>
            {invalid && !checked.ok ? (
              <p id="ac-name-err" className="ob-err">
                {checked.error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="os-card__foot">
        <StatusLine status={status} id="ac-profile-status" />
        {dirty ? (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setName(saved)} disabled={pending}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!dirty || !checked.ok || pending}>
          Save
        </button>
      </div>
    </form>
  );
}

type Step = { kind: "idle" } | { kind: "address" } | { kind: "code"; pending: string };

function EmailCard({ email, onChanged }: { email: string; onChanged: (email: string) => void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  const addressField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const checked = checkNewEmail(draft, email);

  useEffect(() => {
    if (step.kind === "address") addressField.current?.focus();
    if (step.kind === "code") codeField.current?.focus();
  }, [step.kind]);

  const cancel = () => {
    setStep({ kind: "idle" });
    setDraft("");
    setCode("");
    setError(null);
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (pending) return;
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    start(async () => {
      const result = await requestEmailChange(checked.email);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setCode("");
      setStep({ kind: "code", pending: result.pendingEmail });
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (pending || step.kind !== "code") return;
    if (!isCode(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code from the email.`);
      return;
    }
    start(async () => {
      const result = await confirmEmailChange(code);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const old = email;
      onChanged(result.user.email);
      // The sign-in page suggests the last account used on this browser; keep it pointing here.
      const remembered = readRememberedAccount();
      if (remembered && remembered.email.toLowerCase() === old.toLowerCase()) rememberAccount(result.user.email);
      cancel();
      setStatus({ tone: "ok", text: "Email changed. Your other devices were signed out." });
    });
  };

  return (
    <section className="os-card" aria-labelledby="ac-email">
      <div className="os-card__head">
        <h2 id="ac-email">Email address</h2>
        <p>Where sign-in codes and security alerts go.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <span className="ob-l" id="ac-email-l">
            Email<small>verified</small>
          </span>
          <div className="ob-in ro" aria-labelledby="ac-email-l">
            <ObIcon name="mail" />
            <span className="val ac-val">{email}</span>
            {step.kind === "idle" ? (
              <button
                type="button"
                className="ah-btn ah-btn--ghost ah-btn--sm os-copy"
                onClick={() => {
                  setStatus(null);
                  setStep({ kind: "address" });
                }}
                aria-label={`Change email address ${email}`}
              >
                Change
              </button>
            ) : null}
          </div>
        </div>

        {step.kind === "address" ? (
          <form className="os-confirm" onSubmit={send}>
            <p>
              <label htmlFor="ac-new-email">New email address</label>
            </p>
            <div className={`ob-in${error ? " bad" : ""}`}>
              <ObIcon name="mail" />
              <input
                ref={addressField}
                id="ac-new-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="you@example.com"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancel();
                }}
                aria-invalid={error !== null}
                aria-describedby={error ? "ac-email-err" : "ac-email-help"}
              />
            </div>
            {error ? (
              <p id="ac-email-err" className="ob-err" role="alert">
                {error}
              </p>
            ) : (
              <p id="ac-email-help" className="os-help">
                We’ll email a {CODE_LENGTH}-digit code to the new address. Your email stays {email} until you enter it.
              </p>
            )}
            <div className="row">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={cancel} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!draft.trim() || pending}>
                Send code
              </button>
            </div>
          </form>
        ) : null}

        {step.kind === "code" ? (
          <form className="os-confirm" onSubmit={confirm}>
            <p>
              <label htmlFor="ac-code">
                Enter the code we sent to <b>{step.pending}</b>.
              </label>
            </p>
            <div className={`ob-in ac-code${error ? " bad" : ""}`}>
              <ObIcon name="lock" />
              <input
                ref={codeField}
                id="ac-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={CODE_LENGTH + 4}
                value={code}
                onChange={(e) => {
                  setCode(cleanCode(e.target.value).replace(/\D/g, "").slice(0, CODE_LENGTH));
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") cancel();
                }}
                aria-invalid={error !== null}
                aria-describedby={error ? "ac-code-err" : undefined}
              />
            </div>
            {error ? (
              <p id="ac-code-err" className="ob-err" role="alert">
                {error}
              </p>
            ) : null}
            <div className="row">
              <button
                type="button"
                className="ah-btn ah-btn--ghost ah-btn--sm ac-left"
                onClick={() => {
                  setError(null);
                  setStep({ kind: "address" });
                }}
                disabled={pending}
              >
                Use a different address
              </button>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => send()} disabled={pending}>
                Resend code
              </button>
              <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={!isCode(code) || pending}>
                Confirm
              </button>
            </div>
          </form>
        ) : null}
        <StatusLine status={status} id="ac-email-status" />
      </div>
    </section>
  );
}
