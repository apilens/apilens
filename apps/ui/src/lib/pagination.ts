// Pagination state, all of it in the URL (`?page=&per=`), and the pure helpers behind
// components/pagination/pagination.tsx. Unit-tested in pagination.test.ts.
//
// Client-side paging (the API already returns every row): parse the state, slice the rows,
// render the slice and <Pagination>:
//
//   const state = parsePage(searchParams);
//   const { rows, window } = slicePage(endpoints, state);
//   <Table rows={rows} />
//   <Pagination pathname={`/${project}/traffic`} params={searchParams} total={window.total} />
//
// Server-side paging (the API takes offset/limit, or page/per, and returns a total): parse the
// state, ask the API for `pageOffset(state)` and `state.per`, and pass the API's total. When the
// requested page is past the last one (the total shrank, or a hand-edited URL), the API answers
// no rows: read `clampPage(state.page, total, state.per)` and either fetch that page instead or
// redirect to `pageHref(pathname, params, { page: last })`. A list with no total (cursor paging)
// uses <Pagination mode="cursor"> with the API's next/previous cursors (see cursorHref).
//
// Whenever a filter, the range or the sort changes, the page goes back to 1: build those links
// with `hrefWithoutPage` (or drop `page` from the params with `withoutPage`), never by copying
// the current `page` along. `per` is kept: it is a preference, not a position.
//
// While a page live-polls, the total can change under the reader: keep their page and clamp it
// (pageWindow does), so a shrinking list lands them on the new last page instead of an empty one.

import { formatCount } from "./first-data";

/** The page sizes a reader can pick. */
export const PAGE_SIZES: readonly number[] = [25, 50, 100];
/** The page size when the URL names none (or one not offered). */
export const DEFAULT_PER = 25;
/** The URL parameters. */
export const PAGE_PARAM = "page";
export const PER_PARAM = "per";

export type SearchParams = Record<string, string | string[] | undefined>;
export type ParamsInput = SearchParams | URLSearchParams;

/** Where the reader is: the 1-based page and the page size. */
export interface PageState {
  page: number;
  per: number;
}

/**
 * Per-table options: the sizes offered and the default (which must be one of them), and the URL
 * keys, for a page with two paged lists (or a paged list inside a modal over a paged table):
 * `keys: { page: "opage", per: "oper" }`. Default `page` and `per`.
 */
export interface PageOptions {
  sizes?: readonly number[];
  defaultPer?: number;
  keys?: { page: string; per: string };
}

const first = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : (v ?? undefined));
const get = (params: ParamsInput, key: string) => (params instanceof URLSearchParams ? (params.get(key) ?? undefined) : first(params[key]));

function sizesOf(o: PageOptions = {}): { sizes: readonly number[]; defaultPer: number; keys: { page: string; per: string } } {
  const sizes = o.sizes && o.sizes.length > 0 ? o.sizes : PAGE_SIZES;
  const defaultPer = o.defaultPer !== undefined && sizes.includes(o.defaultPer) ? o.defaultPer : sizes.includes(DEFAULT_PER) ? DEFAULT_PER : sizes[0];
  return { sizes, defaultPer, keys: o.keys ?? { page: PAGE_PARAM, per: PER_PARAM } };
}

/** The URL keys of a table's page and page size (`page`/`per` unless `options.keys` names others). */
export const pageKeys = (options?: PageOptions) => sizesOf(options).keys;

/** A whole number written in plain digits (`"3"`, not `"3.5"`, `"3e2"`, `"0x3"` or `" 3"`). */
function wholeNumber(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

/**
 * Reads `?page=&per=`. A missing, non-numeric or < 1 page is 1; a `per` that is not one of the
 * table's sizes is the default. The page is not clamped to the last page here (that needs the
 * total): use pageWindow or clampPage.
 */
export function parsePage(params: ParamsInput, options?: PageOptions): PageState {
  const { sizes, defaultPer, keys } = sizesOf(options);
  const page = wholeNumber(get(params, keys.page));
  const per = wholeNumber(get(params, keys.per));
  return { page: page !== null && page >= 1 ? page : 1, per: per !== null && sizes.includes(per) ? per : defaultPer };
}

/** How many pages `total` rows make at `per` a page; 0 when there are no rows. */
export function pageCount(total: number, per: number): number {
  if (!Number.isFinite(total) || total <= 0 || per <= 0) return 0;
  return Math.ceil(total / per);
}

/** `page` kept within 1..last; 1 when there are no rows. */
export function clampPage(page: number, total: number, per: number): number {
  const pages = pageCount(total, per);
  if (pages === 0 || !Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), pages);
}

/** The 0-based offset of the page's first row, for an API that takes offset/limit. */
export function pageOffset(state: PageState): number {
  return (Math.max(1, Math.floor(state.page)) - 1) * state.per;
}

/** The page the reader is on, clamped to the total, with the rows it shows. */
export interface PageWindow {
  page: number;
  per: number;
  total: number;
  pages: number;
  /** 0-based slice bounds: rows[start..end). */
  start: number;
  end: number;
  /** 1-based, for "Showing 26–50 of 312"; both 0 when there are no rows. */
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function pageWindow(state: PageState, total: number): PageWindow {
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const pages = pageCount(t, state.per);
  const page = clampPage(state.page, t, state.per);
  const start = t === 0 ? 0 : (page - 1) * state.per;
  const end = Math.min(t, start + state.per);
  return { page, per: state.per, total: t, pages, start, end, from: t === 0 ? 0 : start + 1, to: end, hasPrev: page > 1, hasNext: page < pages };
}

/** Client-side paging: the rows of the reader's page (clamped), and the window. */
export function slicePage<T>(rows: readonly T[], state: PageState): { rows: T[]; window: PageWindow } {
  const window = pageWindow(state, rows.length);
  return { rows: rows.slice(window.start, window.end), window };
}

/** `Showing 26–50 of 312` (thousands separated); empty when there are no rows. */
export function rangeText(w: Pick<PageWindow, "from" | "to" | "total">): string {
  if (w.total <= 0) return "";
  return `Showing ${formatCount(w.from)}–${formatCount(w.to)} of ${formatCount(w.total)}`;
}

/** Whether the controls are worth showing: false when every row fits on one page. */
export function needsPagination(w: Pick<PageWindow, "pages">): boolean {
  return w.pages > 1;
}

export type PageItem = number | "gap";

/**
 * The page numbers to show: always the first and the last, the current page with `siblings` on
 * each side, and "gap" where pages are left out. A gap never hides a single page (it shows the
 * page instead), so the row has a stable length: 1 … 4 5 6 … 20.
 */
export function pageItems(page: number, pages: number, siblings = 1): PageItem[] {
  if (pages <= 0) return [];
  const p = Math.min(Math.max(1, page), pages);
  // first + last + current + 2 siblings + 2 gaps
  const slots = 2 * siblings + 5;
  if (pages <= slots) return Array.from({ length: pages }, (_, i) => i + 1);
  const lo = Math.max(2, p - siblings);
  const hi = Math.min(pages - 1, p + siblings);
  const showLeftGap = lo > 3;
  const showRightGap = hi < pages - 2;
  const out: PageItem[] = [1];
  if (!showLeftGap) {
    // Near the start: 1 2 3 4 5 … 20
    for (let i = 2; i <= Math.max(hi, slots - 2); i++) out.push(i);
    out.push("gap", pages);
    return out;
  }
  if (!showRightGap) {
    // Near the end: 1 … 16 17 18 19 20
    out.push("gap");
    for (let i = Math.min(lo, pages - (slots - 3)); i <= pages; i++) out.push(i);
    return out;
  }
  out.push("gap");
  for (let i = lo; i <= hi; i++) out.push(i);
  out.push("gap", pages);
  return out;
}

/** The page that keeps the reader's first row in view when the page size changes. */
export function pageForPer(w: Pick<PageWindow, "from">, per: number): number {
  return w.from <= 1 ? 1 : Math.floor((w.from - 1) / per) + 1;
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

function withQuery(pathname: string, p: URLSearchParams): string {
  const s = p.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/**
 * `params` without `page` (and without any other page `keys` passed, e.g. a second list's), so a
 * link built from them starts at page 1. Everything else is kept.
 */
export function withoutPage(params: ParamsInput, keys: readonly string[] = []): URLSearchParams {
  const p = toSearch(params);
  p.delete(PAGE_PARAM);
  for (const k of keys) p.delete(k);
  return p;
}

/**
 * The link for a filter, range or sort change: `params` with `patch` applied (a null or empty value
 * removes the key) and `page` dropped, so the reader starts again at page 1.
 */
export function hrefWithoutPage(pathname: string, params: ParamsInput, patch: Record<string, string | null | undefined> = {}): string {
  const p = withoutPage(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") p.delete(k);
    else p.set(k, v);
  }
  return withQuery(pathname, p);
}

/**
 * The link to another page or page size, keeping every other parameter. Page 1 and the default
 * size are left out of the URL, so the canonical first page has no `page` at all.
 */
export function pageHref(pathname: string, params: ParamsInput, to: { page?: number; per?: number }, options?: PageOptions): string {
  const { defaultPer, keys } = sizesOf(options);
  const p = toSearch(params);
  if (to.per !== undefined) {
    if (to.per === defaultPer) p.delete(keys.per);
    else p.set(keys.per, String(to.per));
  }
  if (to.page !== undefined) {
    if (to.page <= 1) p.delete(keys.page);
    else p.set(keys.page, String(Math.floor(to.page)));
  }
  return withQuery(pathname, p);
}

// Forward-only cursors ----------------------------------------------------------------------
//
// Some APIs only page one way: each answer carries a `next_cursor` for the older rows and nothing
// for the newer ones (GET /requests, GET /alerts/events). To still offer Newer, the URL keeps the
// trail of cursors walked so far (`?cursor=c1.c2.c3`, the current page's cursor last): Older
// appends the API's next_cursor, Newer drops the last one, Newest drops them all. The trail is
// capped, so a very long walk forgets its first steps (Newer then lands on the newest page early)
// rather than growing the URL without bound.

/** The URL key of the cursor trail. */
export const TRAIL_PARAM = "cursor";
/** The most cursors a trail keeps. */
export const MAX_TRAIL = 30;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

/** The cursor trail in `params` (empty on the newest page); a trail with any malformed cursor reads as empty. */
export function parseTrail(params: ParamsInput, key = TRAIL_PARAM): string[] {
  const raw = get(params, key);
  if (!raw) return [];
  const trail = raw.split(".");
  return trail.every((c) => CURSOR.test(c)) ? trail.slice(-MAX_TRAIL) : [];
}

/** The cursor of the page the trail is on (what to pass the API), or undefined on the newest page. */
export const trailCursor = (trail: readonly string[]): string | undefined => trail[trail.length - 1];

/**
 * The links of a forward-only cursor list: `olderHref` with the API's `next` cursor appended (null
 * when the API sent none: the oldest page), `newerHref` one step back (null on the newest page) and
 * `newestHref` back to the start. Every other parameter is kept.
 */
export function trailHrefs(
  pathname: string,
  params: ParamsInput,
  next: string | null | undefined,
  key = TRAIL_PARAM,
): { olderHref: string | null; newerHref: string | null; newestHref: string; page: number } {
  const trail = parseTrail(params, key);
  const at = (t: string[]) => {
    const p = toSearch(params);
    p.delete(PAGE_PARAM);
    if (t.length) p.set(key, t.join("."));
    else p.delete(key);
    return withQuery(pathname, p);
  };
  return {
    olderHref: next && CURSOR.test(next) ? at([...trail, next].slice(-MAX_TRAIL)) : null,
    newerHref: trail.length ? at(trail.slice(0, -1)) : null,
    newestHref: at([]),
    page: trail.length + 1,
  };
}

/**
 * Cursor paging (no total): the link that shows the rows before or after a cursor the API
 * returned. `page` and the other cursor are dropped, so only one direction is ever in the URL.
 */
export function cursorHref(pathname: string, params: ParamsInput, cursor: { before: string } | { after: string }, keys: { before: string; after: string } = { before: "before", after: "after" }): string {
  const p = toSearch(params);
  p.delete(PAGE_PARAM);
  p.delete(keys.before);
  p.delete(keys.after);
  if ("before" in cursor) p.set(keys.before, cursor.before);
  else p.set(keys.after, cursor.after);
  return withQuery(pathname, p);
}
