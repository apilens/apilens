import { cn } from "@/lib/utils";
import { formatDelta } from "@/lib/format";
import { Sparkline } from "./sparkline";

/**
 * KPI contract: label (sentence case, no colon) · value (pre-formatted,
 * proportional figures) · optional delta vs a NAMED period, colored by
 * direction × whether up is good · optional 12-point trend.
 */
export function StatTile({
  label,
  value,
  delta,
  upIsGood = true,
  period = "vs previous 24h",
  trend,
  className,
}: {
  label: string;
  value: string;
  delta?: number;
  upIsGood?: boolean;
  period?: string;
  trend?: number[];
  className?: string;
}) {
  const good = delta === undefined || delta === 0 ? null : delta > 0 === upIsGood;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 px-4 py-3", className)}>
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-semibold text-foreground">{value}</span>
        {trend ? <Sparkline points={trend} label={`${label} trend`} /> : null}
      </div>
      {delta !== undefined ? (
        <span className="text-xs text-subtle-foreground">
          <span className={cn("font-medium tabular-nums", good === null ? "text-muted-foreground" : good ? "text-success" : "text-danger")}>
            {formatDelta(delta)}
          </span>{" "}
          {period}
        </span>
      ) : null}
    </div>
  );
}

/** A KPI row is one panel divided by hairlines, not four floating cards. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 divide-y divide-border rounded-lg border border-border bg-card shadow-panel sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x",
        className,
      )}
    >
      {children}
    </div>
  );
}
