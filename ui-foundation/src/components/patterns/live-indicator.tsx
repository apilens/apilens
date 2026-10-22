import { cn } from "@/lib/utils";

/**
 * Shown only while data is actually streaming/polling. Paused → say so,
 * don't just stop the dot.
 */
export function LiveIndicator({ paused = false, className }: { paused?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", paused ? "text-subtle-foreground" : "text-brand-text", className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", paused ? "bg-subtle-foreground" : "animate-live bg-brand")} />
      {paused ? "Paused" : "Live"}
    </span>
  );
}
