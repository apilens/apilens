"use client";

// The shared confirmation dialog (#802) for destructive and sensitive actions: a title, what will
// happen, optionally a phrase to type, and the action. A native modal `<dialog>` so focus is
// trapped and the page behind is inert; initial focus is on Cancel (irreversible actions must not
// be one Enter away), Escape cancels, and focus returns to the control that opened it.
// Typing allows paste and password managers. Styled by confirm-dialog.css.
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { confirmMatches } from "@/lib/confirm";
import "./confirm-dialog.css";

export interface ConfirmDialogProps {
  open: boolean;
  /** The question, e.g. "Delete Acme?". Labels the dialog. */
  title: string;
  /** What happens, in the domain's words. Describes the dialog. */
  children: ReactNode;
  /** When set, the action stays disabled until this is typed (see `confirmMatches`). */
  phrase?: string;
  /** Compare the phrase ignoring case (email addresses only). */
  phraseIgnoreCase?: boolean;
  /** The destructive button's label, e.g. "Delete Acme". */
  actionLabel: string;
  /** The action is running: buttons are disabled and Escape does nothing. */
  pending?: boolean;
  /** Why the action failed, shown next to the field. */
  error?: string | null;
  /** Runs the action with what was typed (the server re-checks it). */
  onConfirm: (typed: string) => void;
  /** Closes without acting (Cancel or Escape). */
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  phrase,
  phraseIgnoreCase = false,
  actionLabel,
  pending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [typed, setTyped] = useState("");
  const ids = useId();
  const titleId = `${ids}-t`;
  const bodyId = `${ids}-b`;
  const fieldId = `${ids}-f`;
  const errId = `${ids}-e`;
  const confirmed = phrase === undefined ? true : confirmMatches(phrase, typed, { ignoreCase: phraseIgnoreCase });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      cancelRef.current?.focus();
    } else if (!open && d.open) {
      d.close();
      setTyped("");
      opener.current?.focus();
      opener.current = null;
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!confirmed || pending) return;
    onConfirm(typed);
  };

  return (
    <dialog
      ref={ref}
      className="cd"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        // Escape: the dialog stays under React's control, and a running action can't be abandoned.
        e.preventDefault();
        if (!pending) onCancel();
      }}
    >
      {open ? (
        <form className="cd__in" onSubmit={submit}>
          <h2 id={titleId} className="cd__title">
            {title}
          </h2>
          <div id={bodyId} className="cd__body">
            {children}
          </div>
          {phrase !== undefined ? (
            <div className="cd__field">
              <label htmlFor={fieldId} className="cd__label">
                To confirm, type <code>{phrase}</code> below.
              </label>
              <div className={`ob-in${error ? " bad" : ""}`}>
                <input
                  id={fieldId}
                  value={typed}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={pending}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-invalid={error !== null}
                  aria-describedby={error ? errId : undefined}
                />
              </div>
            </div>
          ) : null}
          {error ? (
            <p id={errId} className="ob-err cd__err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="cd__row">
            <button ref={cancelRef} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button type="submit" className={`ah-btn ah-btn--sm cd__danger${pending ? " is-loading" : ""}`} disabled={!confirmed || pending}>
              {actionLabel}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
