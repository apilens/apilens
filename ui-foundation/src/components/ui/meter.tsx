import { cn } from "@/lib/utils";

/**
 * A ratio against a limit. The fill is neutral until it matters: warning
 * from 75%, danger from 90%. The track is a quieter step of the same surface.
 * Geometry goes through a CSS custom property, never an inline style object.
 */
export function Meter({ value, max, label, className }: { value: number; max: number; label: string; className?: string }) {
  const ratio = Math.min(1, Math.max(0, value / max));
  const tone = ratio >= 0.9 ? "bg-danger" : ratio >= 0.75 ? "bg-warning" : "bg-muted-foreground";
  // ui-guard-ignore no-adhoc-format: CSS width, not a displayed number
  const width = `${(ratio * 100).toFixed(1)}%`;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-accent", className)}
    >
      <div
        className={cn("h-full w-(--meter) rounded-full", tone)}
        style={{ "--meter": width } as React.CSSProperties}
      />
    </div>
  );
}
