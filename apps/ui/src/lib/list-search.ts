// Search and URL upkeep for the settings lists (members, invitations, sessions, health checks).
// The lists are small enough that the API returns every row: they are searched and paged in the
// browser, with the search (`?q=`) and the page (`?page=&per=`, lib/pagination) in the URL so a
// reload, the back button and a shared link land on the same rows. Unit-tested in
// list-search.test.ts. Pure; safe in Client and Server Components alike.
import { PAGE_PARAM, type PageOptions, type PageWindow, type ParamsInput, pageHref, withoutPage } from "./pagination";

/** The search parameter. */
export const SEARCH_PARAM = "q";

/** The longest search kept from a URL; anything after it is ignored. */
const MAX_QUERY = 200;

const first = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : (v ?? undefined));

/** `?q=` as typed (trimmed, at most 200 characters); empty when there is none. */
export function parseQuery(params: ParamsInput): string {
  const raw = params instanceof URLSearchParams ? params.get(SEARCH_PARAM) : first(params[SEARCH_PARAM]);
  return (raw ?? "").trim().slice(0, MAX_QUERY);
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");

/**
 * Whether a row matches the search: every word of `query` appears in at least one of `fields`,
 * ignoring case and accents. An empty query matches every row.
 */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter((f): f is string => typeof f === "string" && f !== "").map(fold);
  return words.every((w) => hay.some((h) => h.includes(w)));
}

/** The rows that match `query` on the fields `of` picks, in their order. */
export function searchRows<T>(rows: readonly T[], query: string, of: (row: T) => readonly (string | null | undefined)[]): T[] {
  if (!query.trim()) return [...rows];
  return rows.filter((r) => matchesQuery(query, of(r)));
}

/**
 * The params with the search set to `query` (removed when empty). A changed search goes back to
 * page 1; the same search keeps the page. Returns a fresh URLSearchParams.
 */
export function withQuery(params: ParamsInput, query: string): URLSearchParams {
  const current = parseQuery(params);
  const q = query.trim();
  const p = q === current ? toSearch(params) : withoutPage(params);
  if (q) p.set(SEARCH_PARAM, q);
  else p.delete(SEARCH_PARAM);
  return p;
}

/**
 * Where the URL should point when the page shown is not the page it names: the list shrank (the
 * last row of the last page was removed, or the list changed while it was open) or a hand-edited
 * `?page=` is past the end. Null when the URL already matches what is shown.
 */
export function canonicalPageHref(pathname: string, params: ParamsInput, shown: Pick<PageWindow, "page">, options?: PageOptions): string | null {
  const raw = params instanceof URLSearchParams ? params.get(PAGE_PARAM) : first(params[PAGE_PARAM]);
  // Page 1 has no `page` in the URL (pageHref leaves it out); any other page names itself exactly.
  const canonical = shown.page === 1 ? raw === undefined || raw === null : raw === String(shown.page);
  if (canonical) return null;
  return pageHref(pathname, params, { page: shown.page }, options);
}

/** The count line above a list: `12 members`, or `3 of 12 members match` while searching. */
export function countLine(shown: number, total: number, one: string, many: string, query: string): string {
  const noun = (n: number) => (n === 1 ? one : many);
  if (!query.trim()) return `${total.toLocaleString("en-US")} ${noun(total)}`;
  return `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${noun(total)} match`;
}

function toSearch(params: ParamsInput): URLSearchParams {
  if (params instanceof URLSearchParams) return new URLSearchParams(params);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  }
  return out;
}
