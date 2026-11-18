"use client";

import { type MouseEvent, useId, useRef, useState } from "react";
import { PopMenu } from "../pop-menu";

/** One item of a field's menu: a filter, a link or a copy. */
export interface FieldAction {
  label: string;
  run?: () => void;
  href?: string;
}

/**
 * The ⋯ menu of a value (#986, after Supabase's DataTableSheetRowAction): Show only this, Exclude,
 * Copy, and what else the field offers (Same minute, Open endpoint, …). It shows on hover or focus
 * of its row; on touch screens it is always there.
 */
export function FieldMenu({ label, copy, actions }: { label: string; copy?: string; actions: readonly FieldAction[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const close = () => setOpen(false);
  const stop = (e: MouseEvent) => e.stopPropagation();

  const doCopy = async () => {
    close();
    try {
      await navigator.clipboard.writeText(copy ?? "");
      setSaid(`Copied ${label}.`);
    } catch {
      setSaid("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };

  return (
    <span className="exa" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
      <button
        ref={trigger}
        type="button"
        className="exa-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      <span className="ex-sr" role="status">
        {said}
      </span>
      <PopMenu open={open} onClose={close} triggerRef={trigger} label={`Actions for ${label}`} id={`${id}-menu`} align="end">
        {actions.map((a) =>
          a.href ? (
            <a key={a.label} role="menuitem" className="cp-sitem" href={a.href} onClick={close}>
              <span className="lb">{a.label}</span>
            </a>
          ) : (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className="cp-sitem"
              onClick={() => {
                close();
                a.run?.();
              }}
            >
              <span className="lb">{a.label}</span>
            </button>
          ),
        )}
        {copy !== undefined ? (
          <button type="button" role="menuitem" className="cp-sitem" onClick={doCopy}>
            <span className="lb">Copy {label.toLowerCase()}</span>
          </button>
        ) : null}
      </PopMenu>
    </span>
  );
}
