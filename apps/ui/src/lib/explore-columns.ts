// Explore's table columns (#1052): their default order and widths, which ones the viewer turned
// on or off and in what order (remembered in this browser), the ones that hide themselves when the
// loaded rows leave them empty, and the ones narrow tables drop. Pure helpers, unit-tested in
// explore-columns.test.ts.
import type { RequestRow } from "./identity";

export type ColumnId = "time" | "status" | "method" | "path" | "app" | "env" | "latency" | "consumer" | "size";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Its CSS grid track. */
  width: string;
  align?: "end";
}

/** Every column in the default order, with Supabase-like widths. Path takes the rest. */
export const COLUMNS: readonly ColumnDef[] = [
  { id: "time", label: "Time", width: "150px" },
  { id: "status", label: "Status", width: "70px" },
  { id: "method", label: "Method", width: "64px" },
  { id: "path", label: "Endpoint", width: "minmax(250px, 1fr)" },
  { id: "app", label: "App", width: "140px" },
  { id: "env", label: "Env", width: "100px" },
  { id: "latency", label: "Latency", width: "80px", align: "end" },
  { id: "consumer", label: "Consumer", width: "160px" },
  { id: "size", label: "Size", width: "80px", align: "end" },
];

export const columnDef = (id: ColumnId): ColumnDef => COLUMNS.find((c) => c.id === id) ?? COLUMNS[0];
const isColumn = (v: unknown): v is ColumnId => COLUMNS.some((c) => c.id === v);

/** The viewer's choices: the order, and the columns turned on (true) or off (false) by hand. */
export interface ColumnPrefs {
  order: ColumnId[];
  shown: Partial<Record<ColumnId, boolean>>;
}

export const DEFAULT_PREFS: ColumnPrefs = { order: COLUMNS.map((c) => c.id), shown: {} };

/** A remembered value as prefs: unknown columns dropped, missing ones added at the end. */
export function readPrefs(v: unknown): ColumnPrefs {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const order = Array.isArray(o.order) ? [...new Set(o.order.filter(isColumn))] : [];
  for (const c of COLUMNS) if (!order.includes(c.id)) order.push(c.id);
  const shown: Partial<Record<ColumnId, boolean>> = {};
  if (typeof o.shown === "object" && o.shown !== null) {
    for (const [k, val] of Object.entries(o.shown)) if (isColumn(k) && typeof val === "boolean") shown[k] = val;
  }
  return { order, shown };
}

export const isPrefs = (v: unknown): v is ColumnPrefs => typeof v === "object" && v !== null && Array.isArray((v as ColumnPrefs).order);

/**
 * The columns that hide themselves for these rows (until turned on by hand): App and Env when the
 * loaded rows show at most one app or environment, Consumer when no row has one.
 */
export function autoHidden(rows: readonly Pick<RequestRow, "app_id" | "environment" | "consumer_id" | "consumer_name">[]): Set<ColumnId> {
  const out = new Set<ColumnId>();
  if (rows.length === 0) return out;
  const distinct = (f: (r: (typeof rows)[number]) => string | undefined) => new Set(rows.map(f).filter((v) => v)).size;
  if (distinct((r) => r.app_id) <= 1) out.add("app");
  if (distinct((r) => r.environment) <= 1) out.add("env");
  if (distinct((r) => (r.consumer_id || r.consumer_name || "").trim()) === 0) out.add("consumer");
  return out;
}

/** Whether a column is on: as the viewer set it, else on unless it hides itself. */
export const isShown = (prefs: ColumnPrefs, auto: ReadonlySet<ColumnId>, id: ColumnId) => prefs.shown[id] ?? !auto.has(id);

/** The columns narrow tables drop: App, Env and Size under 860px, Method too under 640px. */
export function droppedAt(width: number): Set<ColumnId> {
  const out = new Set<ColumnId>();
  if (width > 0 && width < 860) for (const id of ["app", "env", "size"] as const) out.add(id);
  if (width > 0 && width < 640) out.add("method");
  return out;
}

/** The columns the table draws, in order. Path and Time always stay. */
export function visibleColumns(prefs: ColumnPrefs, auto: ReadonlySet<ColumnId>, width: number): ColumnId[] {
  const dropped = droppedAt(width);
  return prefs.order.filter((id) => id === "path" || id === "time" || (isShown(prefs, auto, id) && !dropped.has(id)));
}

/** The grid tracks of a row: the status dot, then each column. */
export const gridTemplate = (cols: readonly ColumnId[]) => ["40px", ...cols.map((id) => columnDef(id).width)].join(" ");

/** `order` with `id` moved to `to` (an index, clamped). */
export function moveColumn(order: readonly ColumnId[], id: ColumnId, to: number): ColumnId[] {
  const rest = order.filter((c) => c !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
