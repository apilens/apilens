"use client";

// The search box and URL upkeep the settings lists share (members, invitations). The rows are
// searched in the browser as the reader types; the search is written to `?q=` (replacing the
// history entry, and dropping `?page=`) a moment later so a reload or a shared link shows the same
// rows. Paging itself is the shared <Pagination> (components/pagination) over lib/pagination.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { canonicalPageHref, parseQuery, withQuery } from "@/lib/list-search";
import type { PageOptions, PageWindow, ParamsInput } from "@/lib/pagination";
import "./list-search.css";

const DEBOUNCE_MS = 250;

function hrefOf(pathname: string, p: URLSearchParams): string {
  const s = p.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/**
 * The search the list shows: what the reader typed (right away) and the params to build page links
 * from (the page's params with that search; page 1 once it differs from the URL's). The URL follows
 * after a short pause; a URL change from elsewhere (back button, a link) resets the box.
 */
export function useListSearch(pathname: string, params: ParamsInput) {
  const router = useRouter();
  const urlQuery = parseQuery(params);
  const [query, setQuery] = useState(urlQuery);
  /** The search this hook last wrote to the URL: its echo must not reset what is typed since. */
  const pushed = useRef<string | null>(null);

  useEffect(() => {
    if (pushed.current === urlQuery) return;
    pushed.current = null;
    setQuery(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    const q = query.trim();
    if (q === urlQuery) return;
    const t = setTimeout(() => {
      pushed.current = q;
      router.replace(hrefOf(pathname, withQuery(params, q)), { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, urlQuery, pathname, params, router]);

  /** Whether the URL already carries what is typed (the page links and the URL agree). */
  const settled = query.trim() === urlQuery;
  return { query, setQuery, params: settled ? params : withQuery(params, query), settled };
}

/**
 * Keeps `?page=` naming the page on screen: when the list shrank under the reader (they removed the
 * last row of the last page, or someone else did) or the URL names a page past the end, the shared
 * pagination already shows the last page; this replaces the URL to match, without a history entry.
 * `params` are the URL's own; pass `shown` null while a typed search is still on its way to the URL.
 */
export function useCanonicalPage(pathname: string, params: ParamsInput, shown: Pick<PageWindow, "page"> | null, options?: PageOptions) {
  const router = useRouter();
  const href = shown ? canonicalPageHref(pathname, params, shown, options) : null;
  useEffect(() => {
    if (href) router.replace(href, { scroll: false });
  }, [href, router]);
}

/** A labelled search box for a list. `label` is read out ("Search members"); the placeholder shows the fields. */
export function ListSearch({ value, onChange, label, placeholder, controls }: { value: string; onChange: (q: string) => void; label: string; placeholder: string; controls?: string }) {
  const id = useId();
  return (
    <div className="ls" role="search">
      <label htmlFor={id} className="ls-label">
        {label}
      </label>
      <span className="ob-in ls-in">
        <svg className="ls-ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          aria-controls={controls}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
        />
      </span>
    </div>
  );
}
