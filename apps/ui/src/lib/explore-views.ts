// Explore saved views (#589): named filter sets of the request log, kept by the API (#578) per
// project. A view saves the conditions (#1052) as `{filter: ["field:op:value", …]}`, the URL's own
// form; views saved before then hold the older one-value filters (`{status: "5xx"}`), read as an
// older link is. The page's range and window are not part of a view. The view in use is the one
// whose conditions are the page's, in any order. Pure helpers (the saved shape, matching, names,
// who edits, the optimistic list), unit-tested in explore-views.test.ts.
import { type Cond, condString, dedupe, legacyConds, parseCond } from "./explore-query";
import type { SavedView } from "./identity";

/** The longest view name the API takes. */
export const MAX_VIEW_NAME = 128;

/** The prefix of the id an optimistic view carries until the API answers. */
export const PENDING_PREFIX = "pending:";
export const isPending = (v: Pick<SavedView, "id">) => v.id.startsWith(PENDING_PREFIX);

/** The conditions as a view saves them. */
export const viewFilter = (conds: readonly Cond[]): { filter: string[] } => ({ filter: conds.map(condString) });

/** The conditions a view holds; values the request log would refuse are dropped, as from a URL. */
export function filtersOfView(v: Pick<SavedView, "filter">): Cond[] {
  const raw = typeof v.filter === "object" && v.filter !== null && !Array.isArray(v.filter) ? (v.filter as Record<string, unknown>) : {};
  const conds = Array.isArray(raw.filter) ? raw.filter.filter((x): x is string => typeof x === "string").map(parseCond) : [];
  const params: Record<string, string> = {};
  for (const [k, val] of Object.entries(raw)) {
    if (k === "filter") continue;
    if (typeof val === "string") params[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) params[k] = String(val);
    else if (typeof val === "boolean") params[k] = String(val);
  }
  return dedupe([...conds.filter((c): c is Cond => c !== null), ...legacyConds(params)]);
}

/** Whether two condition lists hold the same conditions, in any order. */
export function sameSet(a: readonly Cond[], b: readonly Cond[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(condString));
  return b.every((c) => keys.has(condString(c)));
}

/** The view in use: the first one (by name) whose conditions are `conds`, or null. */
export function activeView<V extends Pick<SavedView, "filter">>(views: readonly V[], conds: readonly Cond[]): V | null {
  return views.find((v) => sameSet(filtersOfView(v), conds)) ?? null;
}

/** Views by name, as the switcher lists them. */
export const sortViews = <V extends Pick<SavedView, "name">>(views: readonly V[]): V[] =>
  [...views].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));

/**
 * Checks a view name: trimmed, 1 to 128 characters, and not one the user already gave another of
 * their views (the API refuses that with 409).
 */
export function checkViewName(
  raw: unknown,
  views: readonly Pick<SavedView, "id" | "name" | "created_by">[],
  me: string,
  except?: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return { ok: false, error: "Enter a name for the view." };
  if ([...name].length > MAX_VIEW_NAME) return { ok: false, error: `Use at most ${MAX_VIEW_NAME} characters.` };
  if (views.some((v) => v.id !== except && v.created_by === me && v.name === name)) return { ok: false, error: "You already have a view with this name." };
  return { ok: true, name };
}

/**
 * Whether `me` may rename, share or delete `v`: its creator may; so may a project admin
 * (`capture.manage`) when the view is shared. The API checks the same.
 */
export const canEditView = (v: Pick<SavedView, "created_by" | "shared">, me: string, admin: boolean) => v.created_by === me || (v.shared && admin);

export const VIEW_EDIT_DENIED = "Only the view’s creator or a project admin can change it.";

/** Whether the page's filters can be saved as a new view: some are on and no view holds them. */
export const canSaveFilters = (views: readonly Pick<SavedView, "filter">[], conds: readonly Cond[]) => conds.length > 0 && activeView(views, conds) === null;

/** Puts `v` in the list in place of `replace` (or of the view with its id), kept by name. */
export function upsertView<V extends Pick<SavedView, "id" | "name">>(views: readonly V[], v: V, replace = v.id): V[] {
  return sortViews([...views.filter((x) => x.id !== replace && x.id !== v.id), v]);
}

/** A sentence for a failed view change, by API error code. */
export function viewError(code: string): string {
  switch (code) {
    case "conflict":
      return "You already have a view with this name.";
    case "validation_failed":
    case "bad_request":
    case "invalid_request":
      return `Use a name of 1 to ${MAX_VIEW_NAME} characters.`;
    case "forbidden":
      return VIEW_EDIT_DENIED;
    case "not_found":
      return "That view no longer exists. Reload the page to see the current views.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

export const VIEWS_LOAD_FAILED = "We couldn’t load saved views just now.";
