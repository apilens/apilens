import { cn } from "@/lib/utils";

/**
 * 2px line, recessive by default; the last point is marked in the brand
 * color (the "current period"). Geometry is SVG attributes, not styles.
 */
export function Sparkline({ points, className, label }: { points: number[]; className?: string; label: string }) {
  const w = 96;
  const h = 28;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [pad + (i * (w - pad * 2)) / (points.length - 1), h - pad - ((v - min) / span) * (h - pad * 2)] as const);
  // ui-guard-ignore no-adhoc-format: SVG path coordinates, not displayed numbers
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className={cn("h-7 w-24 overflow-visible", className)}>
      <path d={d} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="stroke-subtle-foreground/60" />
      <circle cx={lx} cy={ly} r="4" strokeWidth="2" className="fill-brand stroke-card" />
    </svg>
  );
}
