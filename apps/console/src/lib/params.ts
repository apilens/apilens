import type { Range, StatusClass } from "./api";

// Every view is driven by URL search params, so any screen can be shared or
// bookmarked and nothing needs client state.

export type SearchParams = Record<string, string | string[] | undefined>;

export const RANGES: { value: Range; label: string; long: string }[] = [
  { value: "1h", label: "1h", long: "last hour" },
  { value: "6h", label: "6h", long: "last 6 hours" },
  { value: "24h", label: "24h", long: "last 24 hours" },
  { value: "7d", label: "7d", long: "last 7 days" },
];

export const STATUS_CLASSES: { value: StatusClass; label: string }[] = [
  { value: "all", label: "All" },
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseRange(sp: SearchParams): Range {
  const v = first(sp.range);
  return RANGES.some((r) => r.value === v) ? (v as Range) : "24h";
}

export function parseEnv(sp: SearchParams): string | undefined {
  const v = first(sp.env)?.trim();
  return v ? v : undefined;
}

export function parseStatus(sp: SearchParams): StatusClass {
  const v = first(sp.status);
  return STATUS_CLASSES.some((s) => s.value === v) ? (v as StatusClass) : "all";
}

export function parsePath(sp: SearchParams): string | undefined {
  const v = first(sp.path)?.trim();
  return v ? v : undefined;
}

export function rangeLong(range: Range): string {
  return RANGES.find((r) => r.value === range)?.long ?? range;
}

/** Link to `pathname` keeping the current filters, with `patch` applied (undefined removes). */
export function hrefWith(pathname: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  const merged = { ...current, ...patch };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "") continue;
    if (k === "range" && v === "24h") continue; // default
    if (k === "status" && v === "all") continue; // default
    q.set(k, v);
  }
  const s = q.toString();
  return s ? `${pathname}?${s}` : pathname;
}
