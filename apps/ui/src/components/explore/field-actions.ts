import { type Cond, type FieldKey, dedupe, makeCond } from "@/lib/explore-query";
import type { FieldAction } from "./field-menu";

/** What a field menu can do to the page: change the conditions, or narrow the window. */
export interface FilterApi {
  conds: Cond[];
  setConds: (conds: Cond[]) => void;
  setWindow: (from: string, to: string) => void;
}

/**
 * "Show only this" (an `=` pill) and "Exclude" (a `≠` pill) for a value of `field`, each replacing
 * the opposite condition on the same value; nothing when the value cannot be a filter.
 */
export function filterActions(api: FilterApi, field: FieldKey, value: string): FieldAction[] {
  const eq = makeCond(field, "eq", value);
  const neq = makeCond(field, "neq", value);
  if (!eq || !neq) return [];
  const without = api.conds.filter((c) => !(c.field === field && (c.op === "eq" || c.op === "neq") && c.value === eq.value));
  return [
    { label: "Show only this", run: () => api.setConds(dedupe([...without, eq])) },
    { label: "Exclude", run: () => api.setConds(dedupe([...without, neq])) },
  ];
}
