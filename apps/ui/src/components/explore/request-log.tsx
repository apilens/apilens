"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { RANGE_LABEL } from "@/lib/consumers";
import {
  EXPLORE_RANGES,
  type ExploreState,
  LOG_LOAD_FAILED,
  LOG_POLL_FAILED,
  LOG_POLL_MS,
  ROW_HEIGHT,
  consumerOf,
  exploreHref,
  formatBytes,
  isSampledOut,
  latencyTone,
  logCaption,
  logPages,
  logPoll,
  logTime,
  moveFocus,
  requestsPath,
  rowKey,
  scopeText,
  statusClass,
  visibleWindow,
} from "@/lib/explore";
import { NO_FILTERS, activeCount } from "@/lib/explore-filters";
import { formatAgo, shownPath } from "@/lib/first-data";
import type { RequestRow, RequestTimeline } from "@/lib/identity";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";
import { Pagination } from "../pagination/pagination";
import { FilterBar } from "./filter-bar";
import { RequestDrawer } from "./request-drawer";
import { Timeline } from "./timeline";

/** How many skeleton rows stand in while another range loads. */
const SKELETON_ROWS = 8;

/**
 * The Explore request log (#585): the project's newest requests (at most 200), one row each with
 * time, method, path, status, latency, consumer and response size. Only the rows in view are in the
 * DOM, so scrolling stays smooth at any page size. Rows are one tab stop: arrows, Page Up/Down,
 * Home and End move between them; keys with ⌘, Ctrl or Alt pass through (⌘K still opens the
 * switcher). While live it reads the log again every 5 s (not while the tab is hidden), keeping
 * the row in focus and the rows in view where they are; Pause stops it (WCAG 2.2.2). A click on a
 * row, or Enter on the focused one, opens the request drawer (#588). Older and Newer under the log
 * walk back past the newest 200 with the API's cursor (`trail`, `older`; lib/explore logPages);
 * live polling runs on the newest page only, and the toolbar says so on an older one.
 * `initial` is null when the API could not answer the first read.
 */
export function RequestLog({
  project,
  environments,
  query: q,
  initial,
  trail,
  older: initialOlder,
  timeline,
  now: serverNow,
  actions,
}: {
  project: string;
  environments: readonly string[];
  query: ExploreState;
  initial: RequestRow[] | null;
  trail: string[];
  older: string;
  timeline: RequestTimeline | null;
  now: number;
  /** The saved-view switcher and Export, at the right end of the toolbar. */
  actions?: ReactNode;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RequestRow[] | null>(initial);
  // The cursor of the rows older than the ones shown, kept in step with the poll.
  const [older, setOlder] = useState(initialOlder);
  const [now, setNow] = useState(serverNow);
  const [paused, setPaused] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [loading, startLoading] = useTransition();
  // The row whose drawer is open (#588); it stays open while the poll replaces the rows.
  const [opened, setOpened] = useState<(RequestRow & { id: string }) | null>(null);
  const open = useCallback((r: RequestRow) => {
    if (r.id) setOpened({ ...r, id: r.id });
  }, []);
  // The poll reads the same range and filters as the page (#586).
  const pollPath = requestsPath(project, q);
  const filtered = activeCount(q.filters) > 0;
  const pages = logPages(project, q, trail, older);
  // Only the newest page is live: an older page is a fixed slice of the past.
  const paged = pages.page > 1;
  const live = !paused && !paged;

  // A new server read (another range, Try again) replaces what the poller had.
  useEffect(() => {
    setRows(initial);
    setOlder(initialOlder);
    setNow(serverNow);
    setPollFailed(false);
  }, [initial, initialOlder, serverNow]);

  useEffect(() => {
    if (!live) return;
    let inflight: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inflight) return;
      inflight = new AbortController();
      try {
        const res = await fetch(pollPath, { signal: inflight.signal, cache: "no-store", headers: { accept: "application/json" } });
        const result = logPoll(res.status, await res.json().catch(() => null));
        if (result.kind === "expired") {
          window.location.assign(result.next);
          return;
        }
        if (result.kind === "error") {
          setPollFailed(true);
          return;
        }
        setPollFailed(false);
        setRows(result.rows);
        setOlder(result.older);
        setNow(Date.now());
      } catch (err) {
        if ((err as Error).name !== "AbortError") setPollFailed(true);
      } finally {
        inflight = null;
      }
    };
    const id = window.setInterval(tick, LOG_POLL_MS);
    return () => {
      window.clearInterval(id);
      inflight?.abort();
    };
  }, [live, pollPath]);

  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    startLoading(() => router.push(href));
  };

  // The filter bar's changes: typing replaces the history entry, a chip or Clear all adds one.
  const navigate = useCallback(
    (href: string, replace: boolean) => startLoading(() => (replace ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false }))),
    [router],
  );

  const clearHref = exploreHref(project, { ...q, filters: NO_FILTERS });

  return (
    <>
      {/* The toolbar: one row of range, filters, saved view, Export and Live. The filter form opens
          on its own full-width line under it (.ex-filters is display: contents). */}
      <div className="ex-tools">
        <nav className="ex-seg" aria-label="Time range">
          {EXPLORE_RANGES.map((r) => {
            // Another range starts over: the timeline's zoom and jump point (#587) belong to this one.
            const href = exploreHref(project, { range: r, filters: q.filters });
            return (
              <a key={r} href={href} onClick={(e) => go(e, href)} aria-current={q.range === r ? "page" : undefined} title={`Last ${RANGE_LABEL[r]}`}>
                {r}
              </a>
            );
          })}
        </nav>
        <FilterBar project={project} environments={environments} query={q} navigate={navigate} />
        <div className="ex-tools__end">
          {actions}
          {paged ? (
            <div className="ex-live">
              <span className="ex-live__state is-paused" title="Live updates run on the newest page only.">
                <span className="ex-live__dot" aria-hidden="true" />
                Older page, not live
              </span>
              <a className="ah-btn ah-btn--ghost ah-btn--sm" href={pages.newestHref} onClick={(e) => go(e, pages.newestHref)}>
                Back to newest
              </a>
            </div>
          ) : (
            <div className="ex-live">
              <span className={`ex-live__state${paused ? " is-paused" : ""}`}>
                <span className="ex-live__dot" aria-hidden="true" />
                {paused ? "Paused" : "Live"}
              </span>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
          )}
        </div>
      </div>

      <Timeline project={project} query={q} initial={timeline} paused={!live} busy={loading} navigate={navigate} />

      {pollFailed && rows !== null ? (
        <div className="ex-notice" role="status">
          <ObIcon name="info" />
          <p>{LOG_POLL_FAILED}</p>
        </div>
      ) : null}

      {loading ? (
        <LogGrid rows={null} now={now} caption="" busy />
      ) : rows === null ? (
        <div className="ex-notice ex-notice--error" role="alert">
          <ObIcon name="info" />
          <p>
            {LOG_LOAD_FAILED}{" "}
            <a className="cp-link" href={exploreHref(project, q)}>
              Try again
            </a>
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="ex-notice" role="status">
          <ObIcon name="info" />
          {paged ? (
            <p>
              No older requests in {scopeText(q)}.{" "}
              <a className="cp-link" href={pages.newestHref} onClick={(e) => go(e, pages.newestHref)}>
                Back to the newest
              </a>
            </p>
          ) : filtered ? (
            <p>
              No requests in {scopeText(q)} match these filters.{" "}
              <a className="cp-link" href={clearHref} onClick={(e) => go(e, clearHref)}>
                Clear all filters
              </a>
            </p>
          ) : (
            <p>No requests in {scopeText(q)}. Once your app reports requests through the SDK, they show up here within seconds.</p>
          )}
        </div>
      ) : (
        <LogGrid
          rows={rows}
          now={now}
          onOpen={open}
          caption={logCaption(q, pages.page, rows.length, filtered)}
          pager={<Pagination mode="cursor" newerHref={pages.newerHref} olderHref={pages.olderHref} label="Request log pages" />}
        />
      )}
      {opened ? <RequestDrawer key={opened.id} project={project} row={opened} onClose={() => setOpened(null)} /> : null}
    </>
  );
}

const COLUMNS = ["Time", "Method", "Path", "Status", "Latency", "Consumer", "Size"] as const;
/** What a header cell says, where it says more than the column's name. */
const HEADER: Partial<Record<(typeof COLUMNS)[number], string>> = { Time: "Time (UTC)" };

/** The grid: a header row and a scrolling, virtualised body. `rows` null draws skeleton rows. */
function LogGrid({
  rows,
  now,
  caption,
  busy = false,
  onOpen,
  pager,
}: {
  rows: RequestRow[] | null;
  now: number;
  caption: string;
  busy?: boolean;
  onOpen?: (row: RequestRow) => void;
  /** Newer and Older, beside the caption. */
  pager?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const frame = useRef(0);
  // The key and offset of the first row in view, to keep it in place when new rows arrive above.
  const anchor = useRef<{ key: string; index: number } | null>(null);

  const count = rows?.length ?? SKELETON_ROWS;
  const keys = rows?.map(rowKey) ?? [];
  const focusIndex = Math.max(0, focusKey === null ? 0 : keys.indexOf(focusKey));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // New rows on top: move the scroll by as many rows, so what the reader looks at stays put.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a || !rows || el.scrollTop <= 0) return;
    const moved = rows.findIndex((r, i) => rowKey(r, i) === a.key);
    if (moved > a.index) {
      el.scrollTop += (moved - a.index) * ROW_HEIGHT;
      setScrollTop(el.scrollTop);
    }
  }, [rows]);

  useEffect(() => {
    if (!rows) return;
    const first = Math.min(rows.length - 1, Math.floor(scrollTop / ROW_HEIGHT));
    anchor.current = first >= 0 ? { key: rowKey(rows[first], first), index: first } : null;
  }, [rows, scrollTop]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(scroller.current?.scrollTop ?? 0));
  }, []);

  const focusRow = (index: number) => {
    const el = scroller.current;
    if (!el || !rows) return;
    // Row `index` spans [index * ROW_HEIGHT, +ROW_HEIGHT) below the sticky header row.
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight - ROW_HEIGHT) el.scrollTop = top + 2 * ROW_HEIGHT - el.clientHeight;
    setScrollTop(el.scrollTop);
    setFocusKey(keys[index]);
    // The row may only be rendered after the scroll: focus it once it is in the DOM.
    // With the timeline (#587) above, the grid can reach below the fold: bring the row onto the page
    // too (the grid already shows it, so "nearest" moves only the page).
    requestAnimationFrame(() => {
      const row = el.querySelector<HTMLElement>(`[data-index="${index}"]`);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !rows) return;
    if (e.key === "Enter" && onOpen && rows[focusIndex] && (e.target as HTMLElement).dataset.index !== undefined) {
      e.preventDefault();
      onOpen(rows[focusIndex]);
      return;
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const next = moveFocus(e.key, focusIndex, rows.length, page);
    if (next === null) return;
    e.preventDefault();
    focusRow(next);
  };

  const { start, end } = visibleWindow(scrollTop, viewport > ROW_HEIGHT ? viewport - ROW_HEIGHT : 0, count);
  const shown = [];
  for (let i = start; i < end; i++) {
    shown.push(
      rows ? (
        <LogRow key={keys[i]} row={rows[i]} index={i} now={now} focusable={i === focusIndex} onFocus={setFocusKey} onOpen={onOpen} rowId={keys[i]} />
      ) : (
        <SkeletonRow key={i} index={i} />
      ),
    );
  }

  return (
    <div className="ex-card">
      {/* The grid scrolls itself; its header row sticks to the top, so columns always line up. */}
      <div
        className="ex-grid"
        role="grid"
        aria-label="Requests"
        aria-rowcount={count + 1}
        aria-colcount={COLUMNS.length}
        aria-busy={busy || undefined}
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div role="rowgroup" className="ex-head">
          <div className="ex-row ex-row--head" role="row" aria-rowindex={1}>
            {COLUMNS.map((c) => (
              <div key={c} role="columnheader" className={`ex-cell ex-cell--${c.toLowerCase()}`}>
                {HEADER[c] ?? c}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="ex-spacer" style={{ height: count * ROW_HEIGHT }}>
          {shown}
        </div>
      </div>
      {caption ? (
        <div className="ex-foot">
          <p>{caption}</p>
          {pager}
        </div>
      ) : null}
    </div>
  );
}

const LogRow = memo(function LogRow({
  row: r,
  index,
  now,
  focusable,
  onFocus,
  onOpen,
  rowId,
}: {
  row: RequestRow;
  index: number;
  now: number;
  focusable: boolean;
  onFocus: (key: string) => void;
  onOpen?: (row: RequestRow) => void;
  rowId: string;
}) {
  const consumer = consumerOf(r);
  const path = shownPath(r);
  const tone = latencyTone(r.response_time_ms);
  const status = statusClass(r.status_code);
  const time = logTime(r.timestamp, now);
  // The URL as requested is what reads apart row to row; the route it matched is in the title.
  const pathTitle = r.path && r.path !== path ? `${path}\nRoute ${r.method.toUpperCase()} ${r.path}` : path;
  return (
    <div
      className={`ex-row${onOpen && r.id ? " is-openable" : ""}${status === "4xx" || status === "5xx" ? ` is-${status}` : ""}`}
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      tabIndex={focusable ? 0 : -1}
      onFocus={() => onFocus(rowId)}
      onClick={onOpen && r.id ? () => onOpen(r) : undefined}
      style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
    >
      <div role="gridcell" className="ex-cell ex-cell--time">
        <time dateTime={r.timestamp} title={`${formatAgo(r.timestamp, now)} · ${r.timestamp}`}>
          {/* Another day: the date takes the milliseconds' place, so the column keeps its width. */}
          {time.day ? <span className="ex-time__day">{time.day} </span> : null}
          {time.clock}
          {time.day ? null : <span className="ex-time__ms">{time.ms}</span>}
        </time>
      </div>
      <div role="gridcell" className="ex-cell ex-cell--method">
        {r.method.toUpperCase()}
      </div>
      <div role="gridcell" className="ex-cell ex-cell--path">
        <code title={pathTitle}>{path}</code>
        {isSampledOut(r) ? (
          <span className="ex-sampled" title="Sampled out: the SDK kept a base record without headers or bodies.">
            Sampled out
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="ex-cell ex-cell--status">
        <span className={`ex-status ex-status--${status}`}>{r.status_code}</span>
      </div>
      <div role="gridcell" className={`ex-cell ex-cell--latency ex-lat--${tone}`} title={tone === "ok" ? undefined : tone === "slow" ? "Slower than 500 ms" : "Slower than 2 s"}>
        {formatLatency(r.response_time_ms)}
      </div>
      <div role="gridcell" className="ex-cell ex-cell--consumer">
        {consumer === null ? (
          <span className="ex-faint" title="No consumer identified: the app did not call set_consumer for this request.">
            –
          </span>
        ) : (
          <span title={consumer}>{consumer}</span>
        )}
      </div>
      <div role="gridcell" className="ex-cell ex-cell--size">
        {formatBytes(r.response_size)}
      </div>
    </div>
  );
});

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className="ex-row ex-row--skeleton" role="row" aria-rowindex={index + 2} style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}>
      {COLUMNS.map((c) => (
        <div key={c} role="gridcell" className={`ex-cell ex-cell--${c.toLowerCase()}`}>
          <span className="ex-bone" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}
