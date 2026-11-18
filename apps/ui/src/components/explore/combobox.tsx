"use client";

import { type KeyboardEvent, useState } from "react";

/** One suggestion: `lead` (a method, say) before the main text, `detail` after it, muted. */
export interface ComboOption {
  key: string;
  text: string;
  lead?: string;
  detail?: string;
}

/**
 * A text field with suggestions (#983), the ARIA 1.2 combobox pattern: typing filters the list
 * (the caller passes the options for the current text), ↓/↑ move through it, Enter picks, Escape
 * closes, and what is typed stays a free-text value when nothing is picked.
 */
export function Combobox({
  id,
  value,
  options,
  onType,
  onPick,
  label,
  placeholder,
  mono,
  ...aria
}: {
  id: string;
  value: string;
  options: readonly ComboOption[];
  onType: (text: string) => void;
  onPick: (option: ComboOption) => void;
  /** The listbox's name, e.g. "Path suggestions". */
  label: string;
  placeholder?: string;
  mono?: boolean;
  /** The field's own name when no visible label names it (the bar's search, #985). */
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = `${id}-list`;
  const shown = open && options.length > 0;
  const cur = shown && active >= 0 && active < options.length ? active : -1;

  const pick = (o: ComboOption) => {
    onPick(o);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!shown) {
          setOpen(true);
          setActive(e.altKey ? -1 : 0);
        } else setActive((cur + 1) % options.length);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!shown) {
          setOpen(true);
          setActive(options.length - 1);
        } else setActive(cur <= 0 ? options.length - 1 : cur - 1);
        return;
      case "Enter":
        if (cur >= 0) {
          e.preventDefault();
          pick(options[cur]);
        }
        return;
      case "Escape":
        if (shown) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          setActive(-1);
        }
        return;
    }
  };

  return (
    <div className="ex-combo">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={cur >= 0 ? `${listId}-${cur}` : undefined}
        {...aria}
        className={`ex-input${mono ? " ex-input--mono" : ""}`}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onType(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label={label} className="ex-combo__list" hidden={!shown}>
        {shown
          ? options.map((o, i) => (
              <li
                key={o.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cur}
                className={`ex-combo__opt${i === cur ? " is-active" : ""}`}
                // Keep focus in the field, so the pick does not blur it first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== cur && setActive(i)}
                onClick={() => pick(o)}
              >
                {o.lead ? <span className="ex-combo__lead">{o.lead}</span> : null}
                <span className="ex-combo__text">{o.text}</span>
                {o.detail ? <span className="ex-combo__detail">{o.detail}</span> : null}
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
