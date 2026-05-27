"use client";

import { AlertCircle, RotateCw } from "lucide-react";

interface SectionErrorProps {
  /** Headline shown above the error message. */
  title?: string;
  /** Free-form error message. Falls back to a generic copy. */
  message?: string;
  /** Click handler for the retry button. If omitted, no button is shown. */
  onRetry?: () => void;
  /** Override the retry button label. */
  retryLabel?: string;
  /** Compact mode renders inline (no padding box) — for tight cards. */
  compact?: boolean;
}

/**
 * Standard inline error card for a single section's fetch failure. Use this
 * inside a SettingsCard body when its data didn't load — the rest of the page
 * keeps working.
 */
export default function SectionError({
  title = "Couldn't load this section",
  message = "Check your connection and try again.",
  onRetry,
  retryLabel = "Try again",
  compact = false,
}: SectionErrorProps) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: "10px",
        padding: compact ? "12px 0" : "20px 16px",
        background: compact ? "transparent" : "var(--bg-tertiary)",
        border: compact ? "none" : "1px solid var(--border-color)",
        borderRadius: compact ? 0 : "10px",
      }}
    >
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <AlertCircle
          size={18}
          strokeWidth={2}
          style={{ color: "var(--danger, #dc2626)", flexShrink: 0, marginTop: "2px" }}
          aria-hidden="true"
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <strong style={{ fontSize: "14px", color: "var(--text-primary)", fontWeight: 600 }}>
            {title}
          </strong>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {message}
          </span>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="settings-btn settings-btn-secondary settings-btn-sm"
          style={{ marginLeft: "28px" }}
        >
          <RotateCw size={13} />
          {retryLabel}
        </button>
      )}
    </div>
  );
}
