"use client";

// The shared copy-value control (#802): a value in monospace with a copy button (at least
// 24x24 px). The result is announced through `role="status"` without moving focus; when the
// clipboard is blocked the value is selected so the keyboard can copy it. Styled by copy-value.css.
import { useEffect, useId, useRef, useState } from "react";
import "./copy-value.css";

export interface CopyValueProps {
  value: string;
  /** What the value is, for the button's name: "Copy {label}". */
  label: string;
  className?: string;
}

export function CopyValue({ value, label, className }: CopyValueProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const valueRef = useRef<HTMLElement>(null);
  const statusId = useId();

  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
      const el = valueRef.current;
      const sel = typeof window === "undefined" ? null : window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  return (
    <span className={`cv${className ? ` ${className}` : ""}`}>
      <code ref={valueRef} className="cv__value">
        {value}
      </code>
      <button type="button" className="cv__btn" onClick={copy} aria-label={`Copy ${label}`} aria-describedby={statusId}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          {state === "copied" ? (
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </>
          )}
        </svg>
      </button>
      <span id={statusId} className={`cv__status${state === "failed" ? " bad" : ""}`} role="status" aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Couldn’t copy. The value is selected: copy it with your keyboard." : ""}
      </span>
    </span>
  );
}
