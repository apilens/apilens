"use client";

// Re-authentication dialog (#803, D12). A sensitive action whose Server Action answers
// `reauth_required` opens it through `useReauth().withReauth(action)`: the user confirms who they
// are (passkey first, then a code from their authenticator app, then a code emailed to them),
// the session cookie gets an access token with a fresh sign-in time, and the action runs again
// once. Closing it changes nothing.
//
// A native modal `<dialog>` like ConfirmDialog: labelled, focus trapped, Escape cancels, focus
// returns to the opener. The code field allows paste and password managers. Styled by
// confirm-dialog.css (shared dialog frame) and reauth-dialog.css.
import { type FormEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type ActionResult,
  type Cancelled,
  type ReauthOptions,
  reauthError,
  reauthOptions,
  reauthWithCode,
  reauthWithPasskey,
  withReauthRetry,
} from "@/lib/reauth";
import "./confirm-dialog.css";
import "./reauth-dialog.css";

export interface ReauthDialogProps {
  open: boolean;
  /** The user confirmed who they are; the session cookie is already updated. */
  onDone: () => void;
  /** Closed without confirming (Cancel or Escape). */
  onCancel: () => void;
  /** Where focus returns on close; defaults to what had focus when it opened. */
  returnFocus?: RefObject<HTMLElement | null>;
}

type Load = { state: "loading" } | { state: "ready"; options: ReauthOptions } | { state: "error"; message: string };

export function ReauthDialog({ open, onDone, onCancel, returnFocus }: ReauthDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [code, setCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const ids = useId();
  const titleId = `${ids}-t`;
  const bodyId = `${ids}-b`;
  const fieldId = `${ids}-f`;
  const errId = `${ids}-e`;

  const reset = () => {
    setLoad({ state: "loading" });
    setCode("");
    setEmailSent(false);
    setPending(false);
    setError(null);
    setStatus("");
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      reset();
      const back = opener.current;
      opener.current = null;
      // The opener may still be disabled while its action settles: try again for up to two seconds.
      let tries = 40;
      const restore = () => {
        if (!back?.isConnected || document.activeElement === back) return;
        back.focus();
        if (document.activeElement !== back && --tries > 0) setTimeout(restore, 50);
      };
      restore();
    }
  }, [open, returnFocus]);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    reauthOptions({ next: window.location.pathname + window.location.search, signal: ctl.signal }).then((r) => {
      if (ctl.signal.aborted) return;
      if (r.ok) {
        setLoad({ state: "ready", options: r.options });
        if (r.options.emailCodeSent) setEmailSent(true);
      } else {
        setLoad({ state: "error", message: reauthError(r.code, r.retryAfter) ?? "Couldn’t confirm it’s you right now. Try again." });
      }
    });
    return () => ctl.abort();
  }, [open]);

  const options = load.state === "ready" ? load.options : null;
  const has = (m: string) => options?.methods.includes(m as never) === true;
  const codeMethod: "totp" | "email" | null = has("totp") ? "totp" : has("email") && emailSent ? "email" : null;

  const finish = (r: { ok: true } | { ok: false; code: string; retryAfter?: number }) => {
    setPending(false);
    if (r.ok) {
      onDone();
      return;
    }
    setError(reauthError(r.code, r.retryAfter));
  };

  const confirmWithPasskey = async () => {
    if (!options?.passkey || pending) return;
    setPending(true);
    setError(null);
    finish(await reauthWithPasskey(options.passkey));
  };

  const sendEmail = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const r = await reauthOptions({ sendEmailCode: true });
    setPending(false);
    if (!r.ok) {
      setError(reauthError(r.code, r.retryAfter));
      return;
    }
    setEmailSent(true);
    setStatus(r.options.emailCodeSent ? "We emailed you a code." : "We already emailed you a code. Check your inbox.");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!codeMethod || pending) return;
    if (code.trim() === "") {
      setError("Enter the code.");
      return;
    }
    setPending(true);
    setError(null);
    finish(await reauthWithCode(codeMethod, code));
  };

  let content: ReactNode = null;
  if (load.state === "loading") {
    content = (
      <p className="ra__muted" role="status">
        Checking how you can confirm…
      </p>
    );
  } else if (load.state === "error") {
    content = (
      <p className="ob-err cd__err" role="alert">
        {load.message}
      </p>
    );
  } else if (options && has("sso") && options.ssoUrl) {
    content = (
      <a className="ah-btn ah-btn--primary ah-btn--sm ra__wide" href={options.ssoUrl}>
        Continue with single sign-on
      </a>
    );
  } else if (options) {
    content = (
      <>
        {has("passkey") && options.passkey ? (
          <button type="button" className="ah-btn ah-btn--primary ah-btn--sm ra__wide" onClick={confirmWithPasskey} disabled={pending}>
            Use a passkey
          </button>
        ) : null}
        {codeMethod ? (
          <div className="cd__field">
            <label htmlFor={fieldId} className="cd__label">
              {codeMethod === "totp" ? "Code from your authenticator app" : "Code from the email we sent you"}
            </label>
            <div className={`ob-in${error ? " bad" : ""}`}>
              <input
                id={fieldId}
                name="code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                autoFocus={!has("passkey")}
                disabled={pending}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                }}
                aria-invalid={error !== null}
                aria-describedby={error ? errId : undefined}
              />
            </div>
          </div>
        ) : has("email") ? (
          <button type="button" className={`ah-btn ah-btn--sm ra__wide${has("passkey") ? " ah-btn--ghost" : " ah-btn--primary"}`} onClick={sendEmail} disabled={pending}>
            Email me a code
          </button>
        ) : null}
      </>
    );
  }

  return (
    <dialog
      ref={ref}
      className="cd ra"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        // React dispatches cancel and close up the component tree: keep them from reaching a
        // dialog this one was opened from (the Create API key dialog closes on them).
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      onClose={(e) => e.stopPropagation()}
    >
      {open ? (
        <form className="cd__in" onSubmit={submit} noValidate>
          <h2 id={titleId} className="cd__title">
            Confirm it’s you
          </h2>
          <div id={bodyId} className="cd__body">
            <p>This change needs a recent sign-in. Confirm who you are to continue; you stay signed in.</p>
          </div>
          <div className="ra__methods">{content}</div>
          {error ? (
            <p id={errId} className="ob-err cd__err" role="alert">
              {error}
            </p>
          ) : null}
          <p className="ra__muted" role="status" aria-live="polite">
            {status}
          </p>
          <div className="cd__row">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel}>
              Cancel
            </button>
            {codeMethod ? (
              <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
                Confirm
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </dialog>
  );
}

/**
 * `withReauth(action)` runs a Server Action and, when it answers `reauth_required`, shows the
 * dialog and runs it again once the user confirmed (see `withReauthRetry`). Render `dialog`.
 */
export function useReauth(): {
  withReauth: <T extends ActionResult>(action: () => Promise<T>) => Promise<T | Cancelled>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  // A ref, not state: withReauth runs inside a transition, whose state updates would not commit
  // until the action finished.
  const returnFocus = useRef<HTMLElement | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  // The last control that had focus: a submit button may already have lost it (disabled while
  // its action runs, or never focused by a click in some browsers) when withReauth is called.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const track = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement) lastFocused.current = e.target;
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    setOpen(false);
    resolver.current?.(confirmed);
    resolver.current = null;
  }, []);

  const confirm = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpen(true);
      }),
    [],
  );

  const withReauth = useCallback(
    <T extends ActionResult>(action: () => Promise<T>) => {
      // The control that started the action, before a pending state disables it.
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : lastFocused.current;
      return withReauthRetry(action, confirm);
    },
    [confirm],
  );

  return {
    withReauth,
    dialog: <ReauthDialog open={open} returnFocus={returnFocus} onDone={() => settle(true)} onCancel={() => settle(false)} />,
  };
}
