// Formatting shared by the project pages: counts, "how long ago" and the path a request row shows.
// Pure, so it can be unit tested.
import type { RequestRow } from "./identity";

/** A count with thousands separators. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** How long ago `at` was, from `now`: "just now", "42s ago", "3m ago", "2h ago", "4d ago". */
export function formatAgo(at: string, now: number): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The path to show for a row: the URL as requested when there is one, else the route template. */
export function shownPath(row: Pick<RequestRow, "path" | "raw_path">): string {
  return row.raw_path || row.path;
}
