"use client";

// Shared Pagination. Import: `import { Pagination } from "@/components/pagination/pagination";`
// Helpers: `@/lib/pagination` (parsePage, slicePage, pageWindow, rangeText, pageHref,
// hrefWithoutPage, withoutPage, cursorHref, clampPage, pageOffset, PAGE_SIZES, DEFAULT_PER).
//
// Props (numbered): pathname, params (the page's plain searchParams object, not URLSearchParams,
// when rendered from a server component), total, sizes? (default [25, 50, 100]), defaultPer?
// (default 25), keys? ({ page: "opage", per: "oper" } for a second paged list on one URL),
// label? ("Endpoints pages"), compact?, scroll? (default false), className?.
// Props (cursor): mode="cursor", newerHref, olderHref (null disables), label?, scroll?, className?.
//
//   const state = parsePage(searchParams);                    // ?page=&per=
//   const { rows, window } = slicePage(allRows, state);       // client-side slice, clamped
//   <Table rows={rows} />                                      // total 0: the table's empty state
//   <Pagination pathname={`/${project}/traffic`} params={searchParams} total={window.total} label="Endpoints pages" />
//
// Filter, range or sort links must drop `page`: hrefWithoutPage(pathname, searchParams, { sort: "p95" }).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId } from "react";
import {
  PAGE_SIZES,
  type PageOptions,
  type ParamsInput,
  needsPagination,
  pageForPer,
  pageHref,
  pageItems,
  pageKeys,
  pageWindow,
  parsePage,
  rangeText,
} from "@/lib/pagination";
import "./pagination.css";

interface Common {
  /** The landmark's name, e.g. "Endpoints pages". Name it after the table when a page has two. */
  label?: string;
  /** Force the phone layout (prev, "Page 3 of 13", next) at every width. */
  compact?: boolean;
  /** Scroll to the top after navigating (next/link's `scroll`); off keeps the table in view. */
  scroll?: boolean;
  className?: string;
}

/** Numbered paging over a known total. Page and size come from `params` (`?page=&per=`). */
export interface PagesProps extends Common, PageOptions {
  mode?: "pages";
  /** The page's path, e.g. `/demo/traffic`; every link keeps the other `params`. */
  pathname: string;
  /** The page's search params as the page read them. */
  params: ParamsInput;
  /** Every row the list has (after filters), not just this page's. */
  total: number;
}

/** Newer/Older paging over a list with no total, with the cursors the API returned. */
export interface CursorProps extends Common {
  mode: "cursor";
  /** Link to the newer rows (build it with cursorHref); null on the newest page. */
  newerHref: string | null;
  /** Link to the older rows; null on the oldest page. */
  olderHref: string | null;
}

export type PaginationProps = PagesProps | CursorProps;

/**
 * Paging controls under a table. State lives in the URL, so every page is a link: the controls are
 * anchors with hrefs (they work before JavaScript loads) that next/link enhances into client
 * navigation. Renders nothing when everything fits on one page (or, in cursor mode, when there is
 * nowhere to go), so a table with no rows shows only its own empty state.
 *
 *   <Pagination pathname={`/${project}/traffic`} params={searchParams} total={window.total} label="Endpoints pages" />
 *   <Pagination mode="cursor" newerHref={newer} olderHref={older} label="Request log pages" />
 */
export function Pagination(props: PaginationProps) {
  return props.mode === "cursor" ? <CursorPagination {...props} /> : <PagesPagination {...props} />;
}

function PagesPagination({ pathname, params, total, sizes = PAGE_SIZES, defaultPer, keys, label = "Pagination", compact = false, scroll = false, className }: PagesProps) {
  const router = useRouter();
  const id = useId();
  const options = { sizes, defaultPer, keys };
  const { page: PAGE_PARAM, per: PER_PARAM } = pageKeys(options);
  const w = pageWindow(parsePage(params, options), total);
  if (!needsPagination(w)) return null;
  const href = (page: number) => pageHref(pathname, params, { page }, options);
  const kept = [...toEntries(params)].filter(([k]) => k !== PAGE_PARAM && k !== PER_PARAM);

  return (
    <nav className={["pg", compact ? "pg--compact" : "", className ?? ""].filter(Boolean).join(" ")} aria-label={label}>
      <p className="pg-range" aria-live="polite">
        {rangeText(w)}
      </p>
      <form
        className="pg-size"
        method="get"
        action={pathname}
        onSubmit={(e) => {
          e.preventDefault();
          const per = Number(new FormData(e.currentTarget).get(PER_PARAM));
          router.push(pageHref(pathname, params, { per, page: pageForPer(w, per) }, options), { scroll });
        }}
      >
        {kept.map(([k, v], i) => (
          <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
        ))}
        <label htmlFor={`${id}-per`}>Rows</label>
        <select
          id={`${id}-per`}
          name={PER_PARAM}
          className="pg-select"
          value={w.per}
          onChange={(e) => {
            const per = Number(e.currentTarget.value);
            router.push(pageHref(pathname, params, { per, page: pageForPer(w, per) }, options), { scroll });
          }}
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <noscript>
          <button type="submit" className="pg-btn">
            Apply
          </button>
        </noscript>
      </form>
      <ul className="pg-pages">
        <li>
          <Step href={w.hasPrev ? href(w.page - 1) : null} dir="prev" scroll={scroll}>
            Previous
          </Step>
        </li>
        {pageItems(w.page, w.pages).map((it, i) =>
          it === "gap" ? (
            <li key={`gap-${i}`} className="pg-gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={it} className="pg-num">
              <Link href={href(it)} scroll={scroll} prefetch={false} className="pg-btn" aria-current={it === w.page ? "page" : undefined} aria-label={`Page ${it}`}>
                {it}
              </Link>
            </li>
          ),
        )}
        <li className="pg-of">
          Page {w.page} of {w.pages}
        </li>
        <li>
          <Step href={w.hasNext ? href(w.page + 1) : null} dir="next" scroll={scroll}>
            Next
          </Step>
        </li>
      </ul>
    </nav>
  );
}

function CursorPagination({ newerHref, olderHref, label = "Pagination", scroll = false, className }: CursorProps) {
  if (!newerHref && !olderHref) return null;
  return (
    <nav className={["pg", "pg--cursor", className ?? ""].filter(Boolean).join(" ")} aria-label={label}>
      <ul className="pg-pages">
        <li>
          <Step href={newerHref} dir="prev" scroll={scroll}>
            Newer
          </Step>
        </li>
        <li>
          <Step href={olderHref} dir="next" scroll={scroll}>
            Older
          </Step>
        </li>
      </ul>
    </nav>
  );
}

/** Previous/Next: a link, or a disabled control where there is no page to go to. */
function Step({ href, dir, scroll, children }: { href: string | null; dir: "prev" | "next"; scroll: boolean; children: string }) {
  const content = (
    <>
      {dir === "prev" ? <Chevron dir="prev" /> : null}
      <span className="pg-step__txt">{children}</span>
      {dir === "next" ? <Chevron dir="next" /> : null}
    </>
  );
  if (!href) {
    return (
      <span className="pg-btn pg-step" aria-disabled="true">
        {content}
      </span>
    );
  }
  return (
    <Link href={href} scroll={scroll} prefetch={false} rel={dir} className="pg-btn pg-step">
      {content}
    </Link>
  );
}

function Chevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg className="pg-chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={dir === "prev" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}

function toEntries(params: ParamsInput): [string, string][] {
  if (params instanceof URLSearchParams) return [...params.entries()];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, one]);
  }
  return out;
}
