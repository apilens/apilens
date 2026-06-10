type Tone = "neutral" | "accent" | "healthy" | "warn" | "critical" | "info";

export interface StatusPillProps {
  tone?: Tone;
  interactive?: boolean;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}

/** Aperture <StatusPill> — the one badge/pill/chip. Tone = meaning. */
export default function StatusPill({
  tone = "neutral",
  interactive = false,
  active = false,
  onClick,
  className = "",
  children,
}: StatusPillProps) {
  const classes = [
    "ap-pill",
    tone !== "neutral" ? `tone-${tone}` : "",
    interactive ? "is-interactive" : "",
    active ? "is-active" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  if (interactive) {
    return (
      <button type="button" className={classes} onClick={onClick} aria-pressed={active}>
        {children}
      </button>
    );
  }
  return <span className={classes}>{children}</span>;
}

/** Map an HTTP status code to a semantic tone. */
export function statusCodeTone(status: number): Tone {
  if (status >= 500) return "critical";
  if (status >= 400) return "warn";
  if (status >= 300) return "info";
  return "healthy";
}
