"use client";

import { CSSProperties } from "react";

type SkeletonVariant = "text" | "line" | "avatar" | "card";

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  /** Render this many copies stacked vertically (handy for list placeholders). */
  count?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible label announced by screen readers (defaults to "Loading"). */
  label?: string;
}

const presets: Record<SkeletonVariant, CSSProperties> = {
  text: { height: "14px", borderRadius: "4px", width: "100%" },
  line: { height: "12px", borderRadius: "4px", width: "100%" },
  avatar: { height: "48px", width: "48px", borderRadius: "50%" },
  card: { height: "96px", borderRadius: "12px", width: "100%" },
};

/**
 * Pulsing placeholder for content that's loading. Single styled <div> per
 * variant — uses the existing skeleton-pulse keyframe in globals.css.
 *
 * Use `count` for repeating rows (e.g., session list placeholders) so callers
 * don't have to manage their own .map(). Width/height props override the
 * variant's preset for one-off custom sizes.
 */
export default function Skeleton({
  variant = "text",
  width,
  height,
  count = 1,
  className,
  style,
  label = "Loading",
}: SkeletonProps) {
  const base: CSSProperties = {
    ...presets[variant],
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };

  if (count === 1) {
    return (
      <div
        className={["skeleton-line", className].filter(Boolean).join(" ")}
        style={{ ...base, ...style }}
        role="status"
        aria-label={label}
        aria-busy="true"
      />
    );
  }

  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: "8px", ...style }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={["skeleton-line", className].filter(Boolean).join(" ")}
          style={base}
        />
      ))}
    </div>
  );
}
