"use client";

import { ReactNode } from "react";
import { Info, CheckCircle2, AlertTriangle, AlertCircle, X } from "lucide-react";

export type AlertVariant = "info" | "success" | "warning" | "error";

interface AlertProps {
  variant?: AlertVariant;
  /** Short title — usually one line. Optional. */
  title?: ReactNode;
  /** Body text. Required if title is omitted. */
  children?: ReactNode;
  /** A trailing action like a button or link. */
  action?: ReactNode;
  /** Show a dismiss "X" button. Hooked to onDismiss. */
  onDismiss?: () => void;
  className?: string;
}

const palette: Record<AlertVariant, {
  bg: string;
  border: string;
  fg: string;
  icon: typeof Info;
  iconColor: string;
}> = {
  info: {
    bg: "rgba(0, 112, 243, 0.08)",
    border: "rgba(0, 112, 243, 0.25)",
    fg: "var(--text-primary)",
    icon: Info,
    iconColor: "#3b82f6",
  },
  success: {
    bg: "rgba(0, 200, 83, 0.08)",
    border: "rgba(0, 200, 83, 0.25)",
    fg: "var(--text-primary)",
    icon: CheckCircle2,
    iconColor: "#16a34a",
  },
  warning: {
    bg: "rgba(255, 149, 0, 0.08)",
    border: "rgba(255, 149, 0, 0.3)",
    fg: "var(--text-primary)",
    icon: AlertTriangle,
    iconColor: "#f59e0b",
  },
  error: {
    bg: "rgba(255, 68, 68, 0.08)",
    border: "rgba(255, 68, 68, 0.3)",
    fg: "var(--text-primary)",
    icon: AlertCircle,
    iconColor: "#dc2626",
  },
};

/**
 * Standardized inline alert. Replaces the ad-hoc colored divs scattered
 * across LoginMethodsSection, TwoFactorSection, PasskeyUpsellBanner.
 *
 * Variants pick the right color + icon. `error` and `warning` set
 * role="alert" automatically so screen readers announce them.
 */
export default function Alert({
  variant = "info",
  title,
  children,
  action,
  onDismiss,
  className,
}: AlertProps) {
  const p = palette[variant];
  const Icon = p.icon;
  const isUrgent = variant === "error" || variant === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "status"}
      aria-live={isUrgent ? "assertive" : "polite"}
      className={className}
      style={{
        display: "flex",
        gap: "12px",
        padding: "12px 14px",
        background: p.bg,
        border: `1px solid ${p.border}`,
        borderRadius: "8px",
        color: p.fg,
        fontSize: "13px",
        lineHeight: 1.5,
        alignItems: "flex-start",
      }}
    >
      <Icon
        size={18}
        strokeWidth={2}
        style={{ color: p.iconColor, flexShrink: 0, marginTop: "1px" }}
        aria-hidden="true"
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: action ? "8px" : "2px" }}>
        {title && <strong style={{ fontWeight: 600 }}>{title}</strong>}
        {children && <div style={{ color: "var(--text-secondary)" }}>{children}</div>}
        {action && <div>{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            color: "var(--text-secondary)",
            flexShrink: 0,
            borderRadius: "4px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
