/**
 * The one percentage formatter (#973, decision D1 in #963). Every share,
 * rate and ratio in the UI renders through `formatPercent`, so the same
 * number never shows as `13%` on one page and `12.5%` on another.
 */

/** `n` out of `of` as a ratio (0 when `of` is 0), the input `formatPercent` takes. */
export const ratio = (n: number, of: number): number => (of > 0 ? n / of : 0);

/**
 * A ratio (`0.125` is 12.5%) as a percentage with `digits` decimals (one by default):
 * `0%` for zero, `<0.1%` for a tiny non-zero value, `12.5%`, `25.0%`, `100.0%`.
 */
export function formatPercent(value: number, { digits = 1 }: { digits?: number } = {}): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const pct = value * 100;
  const smallest = 10 ** -digits;
  if (pct < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${pct.toFixed(digits)}%`;
}
