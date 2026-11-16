import type { Comparison } from "@/lib/compare";

/**
 * The "vs previous" line under a summary tile (#1000), coloured by whether the change is good or
 * bad for the number; the arrow and the words carry the direction, so it is not told by colour
 * alone. Nothing renders without a comparison (the previous window had no requests).
 */
export function CompareLine({ comparison }: { comparison: Comparison | null }) {
  if (!comparison) return null;
  return <span className={`tr-compare tr-compare--${comparison.tone}`}>{comparison.text}</span>;
}
