"use client";

import { type ReactNode, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { Icon } from "../icons";

/** How long a copy button says "Copied" (or that the browser refused). */
const SAID_MS = 1600;

/**
 * A copy button that answers in place: its label turns into a check and "Copied" for a moment
 * (or "Couldn’t copy" when the browser blocks the clipboard), with no line of text pushed into
 * the layout. The write starts inside the click, as Safari asks (lib/clipboard). A screen reader
 * hears the result through the button's own live text.
 */
export function CopyAction({
  text,
  label,
  ariaLabel,
  icon,
  className = "ah-btn ah-btn--secondary ah-btn--sm ex-tbtn",
  disabled,
  iconOnly = false,
}: {
  /** What to copy, read at click time. */
  text: () => string;
  label: ReactNode;
  ariaLabel: string;
  icon?: "link" | "copy";
  className?: string;
  disabled?: boolean;
  /** Only the icon shows (a tooltip carries the name); the result still swaps it for a check. */
  iconOnly?: boolean;
}) {
  const [said, setSaid] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(t);
  }, [said]);

  return (
    <button
      type="button"
      className={`${className} ex-copy${said ? ` is-${said}` : ""}${iconOnly ? " ex-tbtn--icon" : ""}`}
      aria-label={said === "copied" ? `${ariaLabel}: copied` : said === "failed" ? `${ariaLabel}: couldn’t copy` : ariaLabel}
      disabled={disabled}
      onClick={() => copyText(text()).then((ok) => setSaid(ok ? "copied" : "failed"))}
    >
      {said === "copied" ? <Icon name="check" /> : icon ? <Icon name={icon} /> : null}
      {iconOnly ? null : <span>{said === "copied" ? "Copied" : said === "failed" ? "Couldn’t copy" : label}</span>}
    </button>
  );
}
