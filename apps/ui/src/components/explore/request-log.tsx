"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
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
  logPoll,
  moveFocus,
  requestsPath,
  rowKey,
  scopeText,
  statusClass,
  visibleWindow,
} from "@/lib/explore";
import { formatAgo, shownPath } from "@/lib/first-data";
import type { RequestRow } from "@/lib/identity";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";

/** How many skeleton rows stand in while another range loads. */
const SKELETON_ROWS = 8;

/**
 * The Explore request log (#585): the project's newest requests (at most 200), one row each with
 * time, method, path, status, latency, consumer and response size. Only the rows in view are in the
 * DOM, so scrolling stays smooth at any page size. Rows are one tab stop: arrows, Page Up/Down,
 * Home and End move between them; keys with ⌘, Ctrl or Alt pass through (⌘K still opens the
 * switcher). While live it reads the log again every 5 s (not while the tab is hidden), keeping
 * the row in focus and the rows in view where they are; Pause stops it (WCAG 2.2.2).
 * `initial` is null when the API could not answer the first read.
 */
export function RequestLog({ project, query: q, initial, now: serverNow }: { project: string; query: ExploreState; initial: RequestRow[] | null; now: number }) {
  const router = useRouter();
  const [rows, setRows] = useState<RequestRow[] | null>(initial);
  const [now, setNow] = useState(serverNow);
  const [paused, setPaused] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [loading, startLoading] = useTransition();
  const range = q.range;

  // A new server read (another range, Try again) replaces what the poller had.
  useEffect(() => {
    setRows(initial);
    setNow(serverNow);
    setPollFailed(false);
  }, [initial, serverNow]);

  useEffect(() => {
    if (paused) return;
    let inflight: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inflight) return;
      inflight = new AbortController();
      try {
        const res = await fetch(requestsPath(project, { range }), { signal: inflight.signal, cache: "no-store", headers: { accept: "application/json" } });
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
  }, [paused, project, range]);

  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    startLoading(() => router.push(href));
  };

  return (
    <>
      <div className="ex-bar">
        <nav className="ex-seg" aria-label="Time range">
          {EXPLORE_RANGES.map((r) => {
            const href = exploreHref(project, { ...q, range: r });
            return (
              <a key={r} href={href} onClick={(e) => go(e, href)} aria-current={q.range === r ? "page" : undefined} title={`Last ${RANGE_LABEL[r]}`}>
                {r}
              </a>
            );
          })}
        </nav>
        <div className="ex-live">
          <span className={`ex-live__state${paused ? " is-paused" : ""}`}>
            <span className="ex-live__dot" aria-hidden="true" />
            {paused ? "Paused" : "Live"}
          </span>
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

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
          <p>No requests in {scopeText(q)}. Once your app reports requests through the SDK, they show up here within seconds.</p>
        </div>
      ) : (
        <LogGrid rows={rows} now={now} caption={`The newest ${rows.length === 1 ? "request" : `${rows.length} requests`} in ${scopeText(q)}, newest first.`} />
      )}
    </>
  );
}

const COLUMNS = ["Time", "Method", "Path", "Status", "Latency", "Consumer", "Size"] as const;

/** The grid: a header row and a scrolling, virtualised body. `rows` null draws skeleton rows. */
function LogGrid({ rows, now, caption, busy = false }: { rows: RequestRow[] | null; now: number; caption: string; busy?: boolean }) {
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
    requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !rows) return;
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
        <LogRow key={keys[i]} row={rows[i]} index={i} now={now} focusable={i === focusIndex} onFocus={setFocusKey} rowId={keys[i]} />
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
                {c}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="ex-spacer" style={{ height: count * ROW_HEIGHT }}>
          {shown}
        </div>
      </div>
      {caption ? <p className="ex-foot">{caption}</p> : null}
    </div>
  );
}

const LogRow = memo(function LogRow({
  row: r,
  index,
  now,
  focusable,
  onFocus,
  rowId,
}: {
  row: RequestRow;
  index: number;
  now: number;
  focusable: boolean;
  onFocus: (key: string) => void;
  rowId: string;
}) {
  const consumer = consumerOf(r);
  const path = shownPath(r);
  const tone = latencyTone(r.response_time_ms);
  const status = statusClass(r.status_code);
  return (
    <div
      className="ex-row"
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      tabIndex={focusable ? 0 : -1}
      onFocus={() => onFocus(rowId)}
      style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
    >
      <div role="gridcell" className="ex-cell ex-cell--time">
        <time dateTime={r.timestamp} title={r.timestamp}>
          {formatAgo(r.timestamp, now)}
        </time>
      </div>
      <div role="gridcell" className="ex-cell ex-cell--method">
        {r.method.toUpperCase()}
      </div>
      <div role="gridcell" className="ex-cell ex-cell--path">
        <code title={path}>{path}</code>
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
        {consumer === null ? <span className="ex-muted">Anonymous</span> : <span title={consumer}>{consumer}</span>}
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
