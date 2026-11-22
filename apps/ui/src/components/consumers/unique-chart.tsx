"use client";

import Link from "next/link";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { type ConsumersQuery, consumersHref } from "@/lib/consumers";
import { exploreHrefFor } from "@/lib/explore";
import { chartPeriod, chartTick, chartTooltipLabel, windowText } from "@/lib/explore-timeline";
import { useTimeZone } from "@/lib/time-zone-context";

type Point = { ts: string; consumers: number; new: number; returning: number };

/** How many time labels the axis shows, spread inside the edges. */
const TICKS = 6;

/**
 * Unique users per bucket at Explore's chart position and size (the `.exc` row, 60px): returning
 * users in grey with the new ones (first seen in that bucket) stacked on top in the accent. As on
 * Traffic, a click or a drag across the bars picks a window and offers to filter this page to it
 * (the default) or to open its requests in Explore; Escape or a click elsewhere lets it go. From
 * the keyboard: ← → move a bucket, Shift widens, Enter picks.
 */
export function UniqueChart({ project, query: q, points, bucketSeconds }: { project: string; query: ConsumersQuery; points: readonly Point[]; bucketSeconds: number }) {
  const tz = useTimeZone();
  const plot = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ a: number; b: number; done: boolean } | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  // A click outside the plot and its menu, or Escape, lets the selection go.
  useEffect(() => {
    if (!sel?.done) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!plot.current?.contains(t) && !menu.current?.contains(t)) setSel(null);
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setSel(null);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [sel?.done]);

  if (points.length === 0) return <section className="exc" aria-label="No users over time" />;
  const at = points.map((p) => Date.parse(p.ts));
  const period = chartPeriod(Math.abs(at[at.length - 1] - at[0]));
  const top = Math.max(1, ...points.map((p) => p.consumers));
  const ticks = Array.from({ length: TICKS }, (_, k) => Math.round(((k + 0.5) * (points.length - 1)) / TICKS));
  // A bucket's width: as the API reports it, else the gap between the first two points, else a minute.
  const step = bucketSeconds > 0 ? bucketSeconds * 1000 : at.length > 1 && at[1] > at[0] ? at[1] - at[0] : 60_000;

  const indexAt = (clientX: number) => {
    const r = plot.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.max(0, Math.min(points.length - 1, Math.floor(((clientX - r.left) / r.width) * points.length)));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const i = indexAt(e.clientX);
    setSel({ a: i, b: i, done: false });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (sel && !sel.done) setSel({ ...sel, b: indexAt(e.clientX) });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!sel || sel.done) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setSel({ ...sel, b: indexAt(e.clientX), done: true });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Enter") return;
    e.preventDefault();
    if (e.key === "Enter") {
      if (focus !== null) setSel({ a: sel && !sel.done ? sel.a : focus, b: focus, done: true });
      return;
    }
    const next = Math.max(0, Math.min(points.length - 1, (focus ?? points.length - 1) + (e.key === "ArrowRight" ? 1 : -1)));
    setFocus(next);
    if (e.shiftKey) setSel((s) => ({ a: s && !s.done ? s.a : (focus ?? next), b: next, done: false }));
    else setSel(null);
  };

  const lo = sel ? Math.min(sel.a, sel.b) : 0;
  const hi = sel ? Math.max(sel.a, sel.b) : 0;
  const picked = sel?.done ? { from: iso(at[lo]), to: iso(at[hi] + step) } : null;
  const maxUsers = points.reduce((n, p) => Math.max(n, p.consumers), 0);

  return (
    <section className="exc cs-chart" aria-label={`Unique users over time, at most ${maxUsers} in one bucket. Click or drag to filter this page to a window.`}>
      <div
        ref={plot}
        className="cs-plot"
        role="group"
        tabIndex={0}
        aria-label="Users per bucket: arrow keys move, Shift widens, Enter picks a window"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onKeyDown={onKey}
      >
        {points.map((p, i) => {
          const label = `${chartTooltipLabel(at[i], period, tz)}: ${p.consumers} ${p.consumers === 1 ? "user" : "users"} (${p.new} new, ${p.returning} returning). Click or drag to filter this page to a window.`;
          return (
            <span key={p.ts} className={`cs-bar${focus === i ? " is-focus" : ""}`} title={sel ? undefined : label} style={{ height: `${(p.consumers / top) * 100}%` }}>
              <span className="cs-bar__new" style={{ height: `${p.consumers ? (p.new / p.consumers) * 100 : 0}%` }} />
            </span>
          );
        })}
        {sel ? <span className="cs-sel" aria-hidden="true" style={{ left: `${(lo / points.length) * 100}%`, width: `${((hi - lo + 1) / points.length) * 100}%` }} /> : null}
      </div>
      {picked ? (
        <div
          ref={menu}
          className="tr-selmenu"
          role="menu"
          aria-label="Selected window"
          style={{ left: `${Math.min(88, Math.max(12, ((lo + hi + 1) / 2 / points.length) * 100))}%` }}
        >
          <p className="tr-selmenu__when">{windowText(picked.from, picked.to, tz)}</p>
          <Link
            role="menuitem"
            className="tr-selmenu__item is-primary"
            href={consumersHref(project, { ...q, from: picked.from, to: picked.to, consumer: null })}
            scroll={false}
            prefetch={false}
            onClick={() => setSel(null)}
          >
            Filter this page to this window
          </Link>
          <a role="menuitem" className="tr-selmenu__item" href={exploreHrefFor(project, { range: q.range, env: q.env, from: picked.from, to: picked.to })}>
            Open these requests in Explore
          </a>
        </div>
      ) : null}
      <div className="cs-axis" aria-hidden="true">
        {ticks.map((i) => (
          <span key={i} style={{ left: `${((i + 0.5) / points.length) * 100}%` }}>
            {chartTick(at[i], period, tz)}
          </span>
        ))}
      </div>
    </section>
  );
}

/** An instant as the URL carries it: RFC 3339 to the second. */
const iso = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
