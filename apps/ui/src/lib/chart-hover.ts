// Pure geometry and text behind the shared chart hover (components/charts). Unit-tested in
// chart-hover.test.ts. Two layouts:
//   "slot"  — bar charts: point i owns the slot [i*w/n, (i+1)*w/n); its centre is (i+0.5)*w/n.
//   "point" — lines, areas and sparklines: point i sits at i*w/(n-1) (sparklinePoints, linePath);
//             the nearest point to x wins.

export type HoverLayout = "slot" | "point";

/** The index of the point under `x` (px from the plot's left), clamped to 0..count-1; null for no points. */
export function indexAt(x: number, width: number, count: number, layout: HoverLayout): number | null {
  if (count <= 0) return null;
  if (count === 1 || width <= 0) return 0;
  if (!Number.isFinite(x)) return null;
  const i = layout === "slot" ? Math.floor((x / width) * count) : Math.round((x / width) * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

/** The x (in the same unit as `width`) where point `i` is drawn: a bar's centre or a line's vertex. */
export function pointX(i: number, width: number, count: number, layout: HoverLayout): number {
  if (count <= 0) return 0;
  if (layout === "slot") return ((i + 0.5) * width) / count;
  return count > 1 ? (i * width) / (count - 1) : 0;
}

/** Arrow keys step, Home/End jump, PageUp/PageDown step by a tenth. Null for keys the chart ignores. */
export function moveIndex(key: string, current: number | null, count: number): number | null {
  if (count <= 0) return null;
  const at = current === null ? count - 1 : Math.min(count - 1, Math.max(0, current));
  const big = Math.max(1, Math.round(count / 10));
  switch (key) {
    case "ArrowRight":
      return current === null ? at : Math.min(count - 1, at + 1);
    case "ArrowLeft":
      return current === null ? at : Math.max(0, at - 1);
    case "PageUp":
      return Math.min(count - 1, at + big);
    case "PageDown":
      return Math.max(0, at - big);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The index kept while the data changes under the reader (live polling): clamped, null when empty. */
export function keepIndex(i: number | null, count: number): number | null {
  if (i === null || count <= 0) return null;
  return Math.min(count - 1, Math.max(0, i));
}

/**
 * The tooltip's left edge: centred on `anchor`, but never past either side of the `box` (all px).
 * A tooltip wider than the box starts at the box's left edge.
 */
export function tooltipLeft(anchor: number, tipWidth: number, boxWidth: number): number {
  if (tipWidth >= boxWidth) return 0;
  return Math.min(Math.max(0, anchor - tipWidth / 2), boxWidth - tipWidth);
}

/** One line of a tooltip: a series name and its formatted value. */
export interface TooltipRow {
  label: string;
  value: string;
  /** A class that paints the series swatch (e.g. `tr-fill-5xx`); omit for single-series charts. */
  swatch?: string;
}

/** What a screen reader hears for a hovered point: `Mar 4, 14:00 UTC. 4xx: 12, 5xx: 3`. */
export function tooltipText(title: string, rows: readonly TooltipRow[]): string {
  const values = rows.map((r) => (r.label ? `${r.label}: ${r.value}` : r.value)).join(", ");
  return [title, values].filter(Boolean).join(". ");
}
