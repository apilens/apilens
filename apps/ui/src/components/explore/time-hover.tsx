"use client";

import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/clipboard";
import { relativeText, stampText } from "@/lib/explore";
import { browserTimeZone } from "@/lib/time-zone";

/** How long the pointer rests on a time before its card opens, and the grace to move into it. */
const OPEN_MS = 200;
const CLOSE_MS = 120;
/** The card's gap from the time (Radix's sideOffset 4). */
const GAP = 4;
/** How long a row says "Copied!" (TimestampInfo's 1 s). */
const COPIED_MS = 1000;

/**
 * A request's time with Supabase's timestamp card (ui-patterns TimestampInfo, used by Unified Logs'
 * HoverCardTimestamp): the time as `19 Nov 26 14:58:13` in the viewer's zone, and on hover a card
 * to its right of UTC, the viewer's zone (and the browser's, when it differs), Relative and
 * Timestamp (epoch ms), each a label, a dashed leader and the value; a click on a row copies it.
 * The card is portalled to <body>: the virtual rows clip their paint.
 */
export function TimeHover({ at, tz, iso }: { at: number; tz: string; iso: string }) {
  const trigger = useRef<HTMLTimeElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), OPEN_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_MS);
  };
  return (
    <>
      <time ref={trigger} className={`exl-time${open ? " is-open" : ""}`} dateTime={iso} onMouseEnter={show} onMouseLeave={hide}>
        {stampText(at, tz)}
      </time>
      {open ? <TimeCard at={at} tz={tz} anchor={trigger} onEnter={() => window.clearTimeout(timer.current)} onLeave={hide} /> : null}
    </>
  );
}

function TimeCard({ at, tz, anchor, onEnter, onLeave }: { at: number; tz: string; anchor: React.RefObject<HTMLElement | null>; onEnter: () => void; onLeave: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [now] = useState(() => Date.now());
  const browser = browserTimeZone();
  // UTC, the viewer's zone, the browser's when it differs (each zone once), Relative, Timestamp.
  const zones = [...new Set(["UTC", tz, ...(browser ? [browser] : [])])];
  const rows: [string, string][] = [...zones.map((z): [string, string] => [z, stampText(at, z)]), ["Relative", relativeText(at, now)], ["Timestamp", String(at)]];

  // Right of the time; aligned to its top in the upper half of the window, to its bottom below it
  // (TimestampInfo's align start/end), kept inside the window.
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    const el = box.current;
    if (!r || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.right + GAP;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - GAP - w);
    let top = r.top < window.innerHeight / 2 ? r.top - 4 : r.bottom + 4 - h;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ top, left });
  }, [anchor]);

  // A click or press in the card stays in it: the row under it (React portals bubble) must not open.
  const stop = (e: MouseEvent) => e.stopPropagation();
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: hover keeps the card open; the rows are buttons.
    <div
      ref={box}
      className="ah exl-tcard"
      role="tooltip"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={stop}
      onMouseDown={stop}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {rows.map(([label, value]) => (
        <CardRow key={label} label={label} value={value} />
      ))}
    </div>,
    document.body,
  );
}

function CardRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={`exl-tcard__row${copied ? " is-copied" : ""}`}
      aria-label={`Copy ${label}: ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        copyText(value).then((ok) => ok && setCopied(true));
      }}
    >
      <span className="exl-tcard__label">
        <span className="exl-tcard__name">{label}</span>
        <span className="exl-tcard__lead" aria-hidden="true" />
      </span>
      <span className="exl-tcard__value">
        <span className="exl-tcard__lead" aria-hidden="true" />
        <span className="exl-tcard__text">{value}</span>
        {copied ? <span className="exl-tcard__said">Copied!</span> : null}
      </span>
    </button>
  );
}
