import { cn } from "@/lib/cn";
import { statusTone, statusWord, type Tone } from "@/lib/status";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/25 bg-danger/10 text-danger",
  info: "border-info/25 bg-info/10 text-info",
};

/** State or a short attribute, never decoration. */
export function Badge({
  tone = "neutral",
  mono,
  className,
  children,
}: {
  tone?: Tone;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border px-1.5 text-2xs font-medium whitespace-nowrap",
        BADGE_TONE[tone],
        mono && "font-mono",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** HTTP method as a fixed-width mono tag; neutral on purpose (method is not state). */
export function MethodBadge({ method }: { method: string }) {
  return (
    <Badge mono className="w-14 justify-center">
      {method.toUpperCase()}
    </Badge>
  );
}

const DOT_TONE: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-subtle-foreground",
};

/** Status is never color alone: the dot always ships with its label. */
export function StatusDot({ tone, label, className }: { tone: Tone; label: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_TONE[tone])} />
      {label}
    </span>
  );
}

/** "500 Server error": code in mono, meaning in words, dot for scanning. */
export function StatusCode({ code, showWord = true }: { code: number; showWord?: boolean }) {
  const tone = statusTone(code);
  return (
    <StatusDot
      tone={tone}
      label={
        <span className="inline-flex items-baseline gap-1.5">
          <span className="font-mono text-xs text-foreground tabular-nums">{code}</span>
          {showWord ? <span className="text-xs text-muted-foreground">{statusWord(code)}</span> : null}
        </span>
      }
    />
  );
}
