"use client";

// Pieces the organization members and invitations pages (#345, #346) share: a control gated with
// its reason, a modal dialog and a dialog's error line. Styled by members.css.
import { type ReactNode, useEffect, useId, useRef } from "react";
import type { Gate } from "@/lib/org-members";

export type Status = { tone: "ok" | "err"; text: string } | null;
export type OrgRef = { slug: string; name: string };

/** The status line for an action's result. */
export const statusOf = (r: { ok: true; message: string } | { ok: false; error: string }): Status =>
  r.ok ? { tone: "ok", text: r.message } : { tone: "err", text: r.error };

/**
 * A control that may be disabled: when `gate` denies it, the control is wrapped so hovering or
 * focusing it shows the reason, and the reason is the control's accessible description.
 * `children` receives the description id (undefined when allowed) and whether it is disabled.
 */
export function Gated({ gate, children }: { gate: Gate; children: (describedBy: string | undefined, disabled: boolean) => ReactNode }) {
  const id = useId();
  if (gate.allowed) return <>{children(undefined, false)}</>;
  return (
    // Focusable so keyboard users reach the reason of a control they cannot use.
    <span className="om-gate" tabIndex={0}>
      {children(id, true)}
      <span id={id} role="tooltip" className="om-tip">
        {gate.reason}
      </span>
    </span>
  );
}

/** A modal `<dialog>`: Esc and a click on the backdrop close it. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="om-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="om-dialog__in">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

export function DialogError({ error, id }: { error: string | null; id: string }) {
  return error ? (
    <p id={id} className="ob-err" role="alert">
      {error}
    </p>
  ) : null;
}
