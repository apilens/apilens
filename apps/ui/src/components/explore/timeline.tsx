"use client";

import { type KeyboardEvent, type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { formatCount, stackBars } from "@/lib/consumers";
import { type ExploreState, LOG_POLL_MS, exploreHref, statusQuickHref, timelinePath } from "@/lib/explore";
import {
  DRAG_THRESHOLD_PX,
  TIMELINE_LOAD_FAILED,
  TIMELINE_SERIES,
  bucketAt,
  bucketText,
  formatInstant,
  instantText,
  isZoomed,
  jumpPoint,
  labelStyle,
  moveBucket,
  selectionWindow,
  timelineTotals,
  timeX,
  timelinePoll,
  windowText,
} from "@/lib/explore-timeline";
import { formatShare } from "@/lib/endpoint-detail";
import type { RequestTimeline } from "@/lib/identity";
import { plotWidth } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";

/** The viewBox width drawn before the plot is measured (server render), stretched by CSS. */
const FALLBACK_W = 960;
/** Plot height in px; the CSS uses the same number. */
const H = 64;

/** The plot's measured width in CSS px, null until measured (same pattern as the Traffic charts). */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(plotWidth(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A bar's tooltip, centred over it but kept inside the plot's `width` px. */
function Tip({ text, center, width }: { text: string; center: number; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const tw = ref.current?.offsetWidth ?? 0;
    setLeft(Math.max(0, Math.min(center - tw / 2, width - tw)));
  }, [text, center, width]);
  return (
    <div ref={ref} className="ex-tl__tip" aria-hidden="true" style={{ left: left ?? 0, visibility: left === null ? "hidden" : undefined }}>
      {text}
    </div>
  );
}

/**
 * The Explore timeline (#587): requests per bucket over the range (or the zoom), stacked by status
 * class. A click on a bar shows the log from that bar's time back (`?at=`); a drag across bars zooms
 * the timeline and the log to them (`?from=&to=`). Keyboard: arrows pick a bar, Shift+arrows select
 * several, Enter applies, Escape drops the selection. While the log is live it reads again with it.
 * `initial` is null when the API could not answer the first read.
 */
export function Timeline({
  project,
  query: q,
  initial,
  paused,
  busy,
  navigate,
}: {
  project: string;
  query: ExploreState;
  initial: RequestTimeline | null;
  paused: boolean;
  busy: boolean;
  navigate: (href: string, replace: boolean) => void;
}) {
  const id = useId();
  const [timeline, setTimeline] = useState<RequestTimeline | null>(initial);
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>();
  const w = measured ?? FALLBACK_W;
  const [hover, setHover] = useState<number | null>(null);
  // A drag or a keyboard selection: the bucket it started on and the one it reaches.
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const drag = useRef<{ x: number; a: number; moved: boolean } | null>(null);
  const path = timelinePath(project, q);

  useEffect(() => setTimeline(initial), [initial]);

  useEffect(() => {
    if (paused) return;
    let inflight: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inflight) return;
      inflight = new AbortController();
      try {
        const res = await fetch(path, { signal: inflight.signal, cache: "no-store", headers: { accept: "application/json" } });
        const result = timelinePoll(res.status, await res.json().catch(() => null));
        if (result.kind === "expired") window.location.assign(result.next);
        else if (result.kind === "timeline") setTimeline(result.timeline);
        // A failed poll keeps the last bars; the log says the refresh failed.
      } catch {
        // Aborted or offline: the next tick tries again.
      } finally {
        inflight = null;
      }
    };
    const t = window.setInterval(tick, LOG_POLL_MS);
    return () => {
      window.clearInterval(t);
      inflight?.abort();
    };
  }, [paused, path]);

  const zoomed = isZoomed(q);
  const resetHref = exploreHref(project, { ...q, from: undefined, to: undefined, at: undefined });
  const newestHref = exploreHref(project, { ...q, at: undefined });
  const go = (e: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }, href: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href, false);
  };

  const buckets = timeline?.buckets ?? [];
  const count = buckets.length;
  const totals = timeline ? timelineTotals(timeline) : null;

  const jump = (i: number) => {
    if (!timeline) return;
    const at = jumpPoint(timeline, i);
    if (at) navigate(exploreHref(project, { ...q, at }), false);
  };
  const zoom = (a: number, b: number) => {
    if (!timeline) return;
    const z = selectionWindow(timeline, a, b);
    if (z) navigate(exploreHref(project, { ...q, ...z, at: undefined }), false);
  };

  const xOf = (e: PointerEvent<HTMLDivElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || count === 0) return;
    const x = xOf(e);
    drag.current = { x, a: bucketAt(x, w, count), moved: false };
    setFocus(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const x = xOf(e);
    const i = bucketAt(x, w, count);
    setHover(count ? i : null);
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(x - d.x) >= DRAG_THRESHOLD_PX) d.moved = true;
    if (d.moved) setSel({ a: d.a, b: i });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const i = bucketAt(xOf(e), w, count);
    setSel(null);
    if (d.moved) zoom(d.a, i);
    else jump(d.a);
  };
  const onPointerCancel = () => {
    drag.current = null;
    setSel(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || count === 0) return;
    const current = focus ?? count - 1;
    if (e.key === "Enter") {
      e.preventDefault();
      if (sel && sel.a !== sel.b) zoom(sel.a, sel.b);
      else jump(current);
      setSel(null);
      return;
    }
    if (e.key === "Escape" && sel) {
      e.preventDefault();
      setSel(null);
      return;
    }
    const next = moveBucket(e.key, current, count);
    if (next === null) return;
    e.preventDefault();
    if (e.shiftKey) setSel((s) => ({ a: s?.a ?? current, b: next }));
    else setSel(null);
    setFocus(next);
  };

  const { top, bars } = stackBars(buckets, TIMELINE_SERIES.map((s) => s.key), w, H);
  const slot = count ? w / count : w;
  const cursor = timeline && q.at ? timeX(timeline, q.at, w) : null;
  const selLo = sel ? Math.min(sel.a, sel.b) : 0;
  const selHi = sel ? Math.max(sel.a, sel.b) : 0;
  const style = timeline ? labelStyle(timeline) : { seconds: false, withDay: false };
  const shown = focus ?? hover;
  const tip = timeline && shown !== null && buckets[shown] ? bucketText(timeline, buckets[shown]) : null;
  const total = buckets.reduce((n, b) => n + b.requests, 0);

  return (
    <section className="ex-tl" aria-labelledby={`${id}-h`} aria-busy={busy || undefined}>
      <div className="ex-tl__head">
        <h2 id={`${id}-h`} className="ex-tl__title">
          Requests over time
        </h2>
        {/* The legend is the summary: each status class with its count in the timeline's window. The
            error counts are quick filters (the log narrowed to them; again to undo). */}
        <ul className="ex-tl__legend" aria-label="Requests by status">
          {totals ? (
            <li className="ex-tl__total">
              <strong>{formatCount(totals.requests)}</strong> {totals.requests === 1 ? "request" : "requests"}
            </li>
          ) : null}
          {TIMELINE_SERIES.map((s) => {
            const n = totals ? totals[s.key] : null;
            const quick = s.key === "client_errors" ? "4xx" : s.key === "server_errors" ? "5xx" : null;
            const label = (
              <>
                <span className={`ex-tl__swatch ${s.className}`} aria-hidden="true" />
                {s.label}
                {n !== null ? <span className="ex-tl__n">{formatCount(n)}</span> : null}
              </>
            );
            if (!quick || n === null || (n === 0 && q.filters.status !== quick)) return <li key={s.key}>{label}</li>;
            const { href, active } = statusQuickHref(project, q, quick);
            return (
              <li key={s.key}>
                <a
                  className="ex-tl__quick"
                  href={href}
                  aria-current={active ? "true" : undefined}
                  title={active ? "Show every status again" : `Show only ${quick} responses in the log`}
                  onClick={(e) => go(e, href)}
                >
                  {label}
                </a>
              </li>
            );
          })}
          {totals && totals.client_errors + totals.server_errors > 0 ? (
            <li>
              {(() => {
                const { href, active } = statusQuickHref(project, q, "4xx,5xx");
                return (
                  <a className="ex-tl__quick" href={href} aria-current={active ? "true" : undefined} title={active ? "Show every status again" : "Show only errors (4xx and 5xx) in the log"} onClick={(e) => go(e, href)}>
                    All errors
                    <span className="ex-tl__n">{formatShare((totals.client_errors + totals.server_errors) / Math.max(1, totals.requests))}</span>
                  </a>
                );
              })()}
            </li>
          ) : null}
        </ul>
        <div className="ex-tl__scope">
          {zoomed && q.from && q.to ? (
            <span>
              Zoomed to {windowText(q.from, q.to)}.{" "}
              <a className="cp-link" href={resetHref} onClick={(e) => go(e, resetHref)}>
                Reset zoom
              </a>
            </span>
          ) : null}
          {q.at ? (
            <span>
              Log from {instantText(q.at)} back.{" "}
              <a className="cp-link" href={newestHref} onClick={(e) => go(e, newestHref)}>
                Back to newest
              </a>
            </span>
          ) : null}
        </div>
      </div>

      {timeline === null ? (
        <p className="ex-tl__error" role="status">
          <ObIcon name="info" />
          {TIMELINE_LOAD_FAILED}
        </p>
      ) : (
        <>
          <div
            className="ex-tl__plot"
            ref={ref}
            role="group"
            tabIndex={0}
            aria-label={`Requests over time: ${formatCount(total)} ${total === 1 ? "request" : "requests"} from ${windowText(timeline.from, timeline.to)}`}
            aria-describedby={`${id}-hint`}
            data-measured={measured ?? undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setFocus(null);
              setSel(null);
            }}
          >
            <span className="ex-tl__top" aria-hidden="true">
              {formatCount(top)}
            </span>
            <svg viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <line className="ex-tl__grid" x1="0" x2={w} y1={0.5} y2={0.5} />
              <line className="ex-tl__grid" x1="0" x2={w} y1={H / 2} y2={H / 2} />
              <line className="ex-tl__base" x1="0" x2={w} y1={H - 0.5} y2={H - 0.5} />
              {shown !== null && shown < count ? <rect className="ex-tl__hover" x={shown * slot} y={0} width={slot} height={H} /> : null}
              {bars.map((b) => (
                <g key={b.index} className="ex-tl__bar" data-bucket={b.index}>
                  {b.segments.map((s) => (
                    <rect
                      key={s.key}
                      className={TIMELINE_SERIES.find((x) => x.key === s.key)?.className}
                      x={b.x}
                      y={s.y}
                      width={b.w}
                      height={s.h}
                      rx={b.w >= 6 ? 2 : 0}
                    />
                  ))}
                </g>
              ))}
              {sel ? <rect className="ex-tl__sel" x={selLo * slot} y={0} width={(selHi - selLo + 1) * slot} height={H} /> : null}
              {focus !== null && focus < count ? <rect className="ex-tl__focus" x={focus * slot + 1} y={1} width={Math.max(1, slot - 2)} height={H - 2} /> : null}
              {cursor !== null ? <line className="ex-tl__cursor" x1={cursor} x2={cursor} y1={0} y2={H} /> : null}
            </svg>
            {tip && shown !== null ? <Tip text={tip} center={(shown + 0.5) * slot} width={w} /> : null}
          </div>
          {count ? (
            <div className="ex-tl__axis" aria-hidden="true">
              <span>{formatInstant(buckets[0].ts, style)} UTC</span>
              <span>{formatInstant(timeline.to, style)} UTC</span>
            </div>
          ) : null}
          <p id={`${id}-hint`} className="ex-tl__sr">
            Click a bar to show the log from that time back, or drag across bars to zoom in. With the keyboard, arrow keys pick a bar, Shift with the arrows selects several, and Enter applies.
          </p>
          <p className="ex-tl__sr" aria-live="polite">
            {focus !== null && tip ? (sel && sel.a !== sel.b ? `Selected ${selHi - selLo + 1} bars. ${tip}` : tip) : ""}
          </p>
        </>
      )}
    </section>
  );
}
