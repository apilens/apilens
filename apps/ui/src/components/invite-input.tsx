"use client";

// The invite chip input (#346): one field holding a chip per address, each with its own role,
// plus the entry being typed. Shared by the organization invite dialog (members and invitations
// pages) and onboarding's 'Invite your team' step (#336). Enter, comma, space or Tab after an
// address, or a paste holding several, turns the entry into chips; Backspace on an empty entry
// removes the last chip. Entries that are not addresses become red chips with their reason.
// Controlled: the parent keeps `chips` and `draft` and sends what is still being typed too (see
// `addInviteChips`). Leaving the field keeps the entry as typed: turning it into a chip then
// would move the buttons under the field while they are being clicked.
import { type ClipboardEvent, type KeyboardEvent, useId, useRef } from "react";
import type { InviteRole } from "@/lib/identity";
import { INVITE_ROLES, type InviteChip, addInviteChips } from "@/lib/invite-input";
import { roleLabel } from "@/lib/scope";
import "./invite-input.css";

export interface InviteInputProps {
  /** The entry's id, for the field's `<label htmlFor>`. */
  id: string;
  chips: InviteChip[];
  onChange: (chips: InviteChip[]) => void;
  /** The address being typed. */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** The role new chips get. */
  role: InviteRole;
  /** Marks the field invalid (an error is shown under it). */
  invalid?: boolean;
  /** The id of the help or error text under the field. */
  describedBy?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** The roles a chip can take (default: every invitation role). */
  roles?: readonly InviteRole[];
}

export function InviteInput({ id, chips, onChange, draft, onDraftChange, role, invalid = false, describedBy, disabled = false, autoFocus, placeholder = "ada@example.com", roles = INVITE_ROLES }: InviteInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const bad = invalid || chips.some((c) => !c.valid || c.problem);

  const commit = (text: string) => {
    if (!text.trim()) return;
    onChange(addInviteChips(chips, text, role));
    onDraftChange("");
  };

  const remove = (i: number) => {
    onChange(chips.filter((_, j) => j !== i));
    input.current?.focus();
  };

  const setRole = (i: number, r: InviteRole) => onChange(chips.map((c, j) => (j === i ? { ...c, role: r } : c)));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const typed = draft.trim() !== "";
    if (e.key === "Enter" || e.key === "," || e.key === ";" || ((e.key === " " || e.key === "Tab") && typed)) {
      // Enter with nothing typed submits the form; otherwise it adds the entry.
      if (e.key === "Enter" && !typed) return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
      e.preventDefault();
      remove(chips.length - 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
  };

  return (
    // Clicking anywhere in the field focuses the entry; chips and their controls stay keyboard reachable.
    <div className={`ii${bad ? " bad" : ""}${disabled ? " off" : ""}`} onClick={() => input.current?.focus()}>
      {chips.length > 0 ? (
        <ul className="ii-chips" aria-label="Addresses to invite">
          {chips.map((c, i) => {
            const why = c.valid ? c.problem : "not an email";
            return (
            <li key={c.email} className={`ii-chip${why ? " bad" : ""}`}>
              <span className="ii-email" aria-describedby={why ? `${reasonId}-${i}` : undefined}>
                {c.email}
              </span>
              {!why ? (
                <select
                  className="ii-role"
                  value={c.role}
                  disabled={disabled}
                  aria-label={`Role for ${c.email}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRole(i, e.target.value as InviteRole)}
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              ) : (
                <span id={`${reasonId}-${i}`} className="ii-why">
                  {why}
                </span>
              )}
              <button
                type="button"
                className="ii-x"
                aria-label={`Remove ${c.email}`}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
              >
                ×
              </button>
            </li>
            );
          })}
        </ul>
      ) : null}
      <input
        ref={input}
        id={id}
        type="text"
        inputMode="email"
        value={draft}
        placeholder={chips.length ? "Add another" : placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        aria-invalid={bad}
        aria-describedby={describedBy}
      />
    </div>
  );
}
