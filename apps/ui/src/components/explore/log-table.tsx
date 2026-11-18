"use client";

import { type KeyboardEvent, type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { consumerOf, formatBytes, isSampledOut, latencyTone, logTime, moveFocus, rowKey, statusClass, visibleWindow } from "@/lib/explore";
import { type ColumnId, type ColumnPrefs, autoHidden, columnDef, gridTemplate, visibleColumns } from "@/lib/explore-columns";
import { formatCount } from "@/lib/consumers";
import { shownPath } from "@/lib/first-data";
import { statusText } from "@/lib/http-status";
import type { RequestRow } from "@/lib/identity";
import { zoneLabel, zoned } from "@/lib/time-zone";
import { useTimeZone } from "@/lib/time-zone-context";
import { formatLatency } from "@/lib/traffic";
import { useAppName } from "./app-names";

/** Row heights in px: one line on wide tables, two on phones (path, then time · status · latency). */
export const ROW_H = 30;
export const ROW_H_PHONE = 52;
/** Under this width the table reads as a phone's: two-line rows. */
export const PHONE_W = 640;
/** How close to the end (px) the next page starts loading (Supabase's 300px). */
const LOAD_AHEAD_PX = 300;
/** Shimmer rows while the first page loads. */
const SKELETON_ROWS = 12;

const UTC_TIME: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", fractionalSecondDigits: 3 };

/**
 * Explore's table (#1052, after Supabase's DataTableInfinite): 30px rows of 12px mono time, status,
 * method, path and latency under a sticky header. Only the rows in view are in the DOM, so
 * thousands scroll smoothly; the next page loads 300px before the end, with "Load more" as a
 * fallback. 5xx rows carry a faint red wash, 4xx an amber one. Columns come from the viewer's
 * choices, minus the ones that hide themselves (empty on these rows) and the ones narrow tables
 * drop; under 640px rows take two lines. Rows from before Live was switched on (`dimBefore`) are
 * dimmed so new ones stand out. Rows are one tab stop: arrows, Page Up/Down, Home and End move;
 * Enter or a click opens the request.
 */
export function LogTable({
  rows,
  prefs,
  now,
  dimBefore,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  caption,
}: {
  /** null draws the shimmer rows of a first load. */
  rows: RequestRow[] | null;
  prefs: ColumnPrefs;
  now: number;
  /** Rows at or before this instant (ms) are dimmed; null dims none. */
  dimBefore: number | null;
  /** How many requests match, from the chart; null when unknown. */
  total: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen?: (row: RequestRow) => void;
  caption?: ReactNode;
}) {
  const tz = useTimeZone();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ h: 0, w: 0 });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const frame = useRef(0);
  // The key and index of the first row in view, to keep it in place when Live adds rows above.
  const anchor = useRef<{ key: string; index: number } | null>(null);

  const phone = size.w > 0 && size.w < PHONE_W;
  const rowH = phone ? ROW_H_PHONE : ROW_H;
  const count = rows?.length ?? SKELETON_ROWS;
  const keys = rows?.map(rowKey) ?? [];
  const focusIndex = Math.max(0, focusKey === null ? 0 : keys.indexOf(focusKey));
  const auto = autoHidden(rows ?? []);
  const cols = visibleColumns(prefs, auto, size.w);
  const template = phone ? "40px minmax(0, 1fr)" : gridTemplate(cols);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ h: el.clientHeight, w: el.clientWidth });
    measure();
    if (typeof ResizeObserver === "undefined") return;
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
      el.scrollTop += (moved - a.index) * rowH;
      setScrollTop(el.scrollTop);
    }
  }, [rows, rowH]);

  useEffect(() => {
    if (!rows) return;
    const first = Math.min(rows.length - 1, Math.floor(scrollTop / rowH));
    anchor.current = first >= 0 ? { key: rowKey(rows[first], first), index: first } : null;
  }, [rows, scrollTop, rowH]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // The next page, once the end is near (also when the first page does not fill the view).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !rows || !hasMore || loadingMore) return;
    if (el.scrollHeight - (scrollTop + el.clientHeight) < LOAD_AHEAD_PX) onLoadMore();
  }, [scrollTop, rows, hasMore, loadingMore, onLoadMore, size.h]);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(scroller.current?.scrollTop ?? 0));
  }, []);

  const focusRow = (index: number) => {
    const el = scroller.current;
    if (!el || !rows) return;
    // Row `index` spans [index * rowH, +rowH) below the sticky header row.
    const top = index * rowH;
    const head = ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight - head) el.scrollTop = top + rowH + head - el.clientHeight;
    setScrollTop(el.scrollTop);
    setFocusKey(keys[index]);
    requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !rows) return;
    if (e.key === "Enter" && onOpen && rows[focusIndex] && (e.target as HTMLElement).dataset.index !== undefined) {
      e.preventDefault();
      onOpen(rows[focusIndex]);
      return;
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowH) - 1);
    const next = moveFocus(e.key, focusIndex, rows.length, page);
    if (next === null) return;
    e.preventDefault();
    focusRow(next);
  };

  const { start, end } = visibleWindow(scrollTop, size.h > ROW_H ? size.h - ROW_H : 0, count, rowH);
  const shown = [];
  for (let i = start; i < end; i++) {
    shown.push(
      rows ? (
        <LogRow
          key={keys[i]}
          row={rows[i]}
          cols={cols}
          phone={phone}
          rowH={rowH}
          template={template}
          index={i}
          now={now}
          dim={dimBefore !== null && Date.parse(rows[i].timestamp) <= dimBefore}
          focusable={i === focusIndex}
          onFocus={setFocusKey}
          onOpen={onOpen}
          rowId={keys[i]}
        />
      ) : (
        <SkeletonRow key={i} index={i} cols={phone ? (["path"] as ColumnId[]) : cols} template={template} rowH={rowH} />
      ),
    );
  }

  return (
    <div className="exl">
      <div
        className={`exl-grid${rows ? "" : " is-loading"}`}
        role="grid"
        aria-label="Requests"
        aria-rowcount={rows ? count + 1 : -1}
        aria-colcount={(phone ? 1 : cols.length) + 1}
        aria-busy={rows ? undefined : true}
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div role="rowgroup" className="exl-head">
          <div className="exl-row exl-row--head" role="row" aria-rowindex={1} style={{ gridTemplateColumns: template }}>
            <div role="columnheader" className="exl-cell exl-cell--dot">
              <span className="ex-sr">Status class</span>
            </div>
            {phone ? (
              <div role="columnheader" className="exl-cell">
                Request
              </div>
            ) : (
              cols.map((id) => (
                <div key={id} role="columnheader" className={`exl-cell exl-cell--${id}`}>
                  {id === "time" ? `Time (${zoneLabel(tz)})` : columnDef(id).label}
                </div>
              ))
            )}
          </div>
        </div>
        <div role="rowgroup" className="exl-body" style={{ height: count * rowH }}>
          {shown}
        </div>
      </div>
      {rows ? (
        <div className="exl-foot">
          <p aria-live="polite">
            Showing {formatCount(rows.length)}
            {total !== null && total >= rows.length ? ` of ${formatCount(total)}` : ""} {total === 1 || (total === null && rows.length === 1) ? "request" : "requests"}
            {caption ? <> · {caption}</> : null}
          </p>
          {hasMore ? (
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const LogRow = memo(function LogRow({
  row: r,
  cols,
  phone,
  rowH,
  template,
  index,
  now,
  dim,
  focusable,
  onFocus,
  onOpen,
  rowId,
}: {
  row: RequestRow;
  cols: readonly ColumnId[];
  phone: boolean;
  rowH: number;
  template: string;
  index: number;
  now: number;
  dim: boolean;
  focusable: boolean;
  onFocus: (key: string) => void;
  onOpen?: (row: RequestRow) => void;
  rowId: string;
}) {
  const tz = useTimeZone();
  const cls = statusClass(r.status_code);
  const openable = Boolean(onOpen && r.id);
  return (
    <div
      className={`exl-row${openable ? " is-openable" : ""}${cls === "4xx" || cls === "5xx" ? ` is-${cls}` : ""}${dim ? " is-old" : ""}${phone ? " is-phone" : ""}`}
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      tabIndex={focusable ? 0 : -1}
      onFocus={() => onFocus(rowId)}
      onClick={openable ? () => onOpen?.(r) : undefined}
      style={{ transform: `translateY(${index * rowH}px)`, height: rowH, gridTemplateColumns: template }}
    >
      <div role="gridcell" className="exl-cell exl-cell--dot">
        <span className={`exl-dot exl-dot--${cls}`} title={statusText(r.status_code)} />
      </div>
      {phone ? (
        <div role="gridcell" className="exl-cell exl-cell--stack">
          <PathText row={r} />
          <span className="exl-sub">
            <TimeText row={r} now={now} tz={tz} /> · <span className={`exl-status exl-status--${cls}`}>{r.status_code}</span> · {formatLatency(r.response_time_ms)}
          </span>
        </div>
      ) : (
        cols.map((id) => <Cell key={id} id={id} row={r} now={now} tz={tz} />)
      )}
    </div>
  );
});

function TimeText({ row: r, now, tz }: { row: RequestRow; now: number; tz: string }) {
  const t = logTime(r.timestamp, now, tz);
  const at = Date.parse(r.timestamp);
  const exact = Number.isNaN(at)
    ? r.timestamp
    : `${zoned("en-US", UTC_TIME, "UTC").format(at)} UTC\n${zoned("en-US", UTC_TIME, tz).format(at)} ${zoneLabel(tz, at)}`;
  return (
    <time dateTime={r.timestamp} title={exact}>
      {t.day ? <span className="exl-faint">{t.day} </span> : null}
      {t.clock}
      <span className="exl-faint">{t.ms}</span>
    </time>
  );
}

function PathText({ row: r }: { row: RequestRow }) {
  const path = shownPath(r);
  const title = r.path && r.path !== path ? `${path}\nRoute ${r.method.toUpperCase()} ${r.path}` : path;
  return (
    // Clipped from the left, so the last segment stays in view; the whole path is in the title.
    <span className="exl-clip" title={title}>
      <bdi>{path}</bdi>
    </span>
  );
}

function Cell({ id, row: r, now, tz }: { id: ColumnId; row: RequestRow; now: number; tz: string }) {
  const app = useAppName(r.app_id);
  const cls = statusClass(r.status_code);
  const content = (() => {
    switch (id) {
      case "time":
        return <TimeText row={r} now={now} tz={tz} />;
      case "status":
        return (
          <span className={`exl-status exl-status--${cls}`} title={statusText(r.status_code)}>
            {r.status_code}
          </span>
        );
      case "method":
        return r.method.toUpperCase();
      case "path":
        return (
          <>
            <PathText row={r} />
            {isSampledOut(r) ? (
              <span className="exl-tag" title="Sampled out: the SDK kept a base record without headers or bodies.">
                Sampled out
              </span>
            ) : null}
          </>
        );
      case "app":
        return app !== null ? <span title={app}>{app}</span> : <span className="exl-faint">–</span>;
      case "env":
        return r.environment ? <span title={r.environment}>{r.environment}</span> : <span className="exl-faint">–</span>;
      case "latency": {
        const tone = latencyTone(r.response_time_ms);
        return (
          <span className={`exl-lat--${tone}`} title={tone === "ok" ? undefined : tone === "slow" ? "Slower than 500 ms" : "Slower than 2 s"}>
            {formatLatency(r.response_time_ms)}
          </span>
        );
      }
      case "consumer": {
        const c = consumerOf(r);
        return c === null ? <span className="exl-faint">–</span> : <span title={c}>{c}</span>;
      }
      case "size":
        return formatBytes(r.response_size);
    }
  })();
  return (
    <div role="gridcell" className={`exl-cell exl-cell--${id}`}>
      {content}
    </div>
  );
}

function SkeletonRow({ index, cols, template, rowH }: { index: number; cols: readonly ColumnId[]; template: string; rowH: number }) {
  return (
    <div className="exl-row exl-row--skeleton" role="row" aria-rowindex={index + 2} style={{ transform: `translateY(${index * rowH}px)`, height: rowH, gridTemplateColumns: template }}>
      <div role="gridcell" className="exl-cell exl-cell--dot">
        <span className="exl-bone exl-bone--dot" aria-hidden="true" />
      </div>
      {cols.map((id) => (
        <div key={id} role="gridcell" className={`exl-cell exl-cell--${id}`}>
          <span className="exl-bone" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}
