"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  /** If set, user must type this exact word before the confirm button enables. */
  confirmWord?: string;
  variant?: "default" | "danger";
  isLoading?: boolean;
}

/**
 * Modal confirmation dialog. Used directly via JSX *or* imperatively through
 * the `useConfirm()` hook. Implements WCAG-friendly focus trap, Escape to
 * close, click-outside to close, and an optional typed-word confirmation.
 */
export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  confirmWord,
  variant = "default",
  isLoading = false,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Remember what was focused before opening so we can restore it on close.
  const previousActiveRef = useRef<HTMLElement | null>(null);

  const isConfirmDisabled = confirmWord
    ? inputValue !== confirmWord || isLoading
    : isLoading;

  // Reset typed input + autofocus the most relevant element on open.
  useEffect(() => {
    if (!isOpen) return;
    setInputValue("");
    previousActiveRef.current = document.activeElement as HTMLElement | null;
    // Focus is deferred to next tick so the rendered nodes exist.
    const id = requestAnimationFrame(() => {
      if (confirmWord) inputRef.current?.focus();
      else cancelBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, confirmWord]);

  // Restore focus to the trigger element when the dialog closes.
  useEffect(() => {
    if (isOpen) return;
    const prev = previousActiveRef.current;
    if (prev && typeof prev.focus === "function") {
      prev.focus();
    }
  }, [isOpen]);

  // Escape closes (only when not in the middle of a confirm action).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLoading) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, isLoading, onClose]);

  // Click outside the dialog closes.
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        dialogRef.current &&
        !dialogRef.current.contains(e.target as Node) &&
        !isLoading
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, isLoading, onClose]);

  // Focus trap: Tab cycles between Cancel ↔ Confirm (or input → Cancel → Confirm).
  // Prevents focus from escaping behind the modal — WCAG requirement.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;

      const focusables: HTMLElement[] = [];
      if (confirmWord && inputRef.current) focusables.push(inputRef.current);
      if (cancelBtnRef.current) focusables.push(cancelBtnRef.current);
      if (confirmBtnRef.current && !isConfirmDisabled) focusables.push(confirmBtnRef.current);

      if (focusables.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const idx = active ? focusables.indexOf(active) : -1;

      // Forward Tab from the last → first; Shift-Tab from the first → last.
      if (!e.shiftKey && idx === focusables.length - 1) {
        e.preventDefault();
        focusables[0].focus();
      } else if (e.shiftKey && idx === 0) {
        e.preventDefault();
        focusables[focusables.length - 1].focus();
      } else if (idx === -1) {
        // Focus was somewhere outside the trap; bring it back.
        e.preventDefault();
        focusables[0].focus();
      }
    },
    [confirmWord, isConfirmDisabled],
  );

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay">
      <div
        className="dialog-content"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-description"
        onKeyDown={handleKeyDown}
      >
        <button
          className="dialog-close"
          onClick={onClose}
          disabled={isLoading}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>

        <div className="dialog-header">
          {variant === "danger" && (
            <div className="dialog-icon-danger">
              <AlertTriangle size={24} />
            </div>
          )}
          <h3 id="confirm-dialog-title" className="dialog-title">{title}</h3>
          <p id="confirm-dialog-description" className="dialog-description">
            {description}
          </p>
        </div>

        {confirmWord && (
          <div className="dialog-input-section">
            <label className="dialog-input-label" htmlFor="confirm-dialog-input">
              Type{" "}
              <code
                style={{
                  background: "var(--bg-tertiary)",
                  padding: "1px 6px",
                  borderRadius: "4px",
                  fontFamily: "monospace",
                  fontWeight: 600,
                }}
              >
                {confirmWord}
              </code>{" "}
              to confirm
            </label>
            <input
              id="confirm-dialog-input"
              ref={inputRef}
              type="text"
              className="dialog-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={confirmWord}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={isLoading}
            />
          </div>
        )}

        <div className="dialog-footer">
          <button
            ref={cancelBtnRef}
            className="settings-btn settings-btn-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            className={`settings-btn ${variant === "danger" ? "settings-btn-danger" : "settings-btn-primary"}`}
            onClick={onConfirm}
            disabled={isConfirmDisabled}
            aria-busy={isLoading || undefined}
          >
            {isLoading ? (
              <span className="btn-loading">
                <span className="btn-spinner" />
                Processing…
              </span>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
