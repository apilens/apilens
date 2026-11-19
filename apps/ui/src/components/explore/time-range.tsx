"use client";

import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type DayKey,
  MONTHS,
  type TimeParts,
  WEEKDAYS,
  addDays,
  addMonths,
  clampPart,
  dayLabel,
  keyParts,
  monthGrid,
  moveDay,
  padPart,
  pickDay,
  stepPart,
  zonedDayTime,
  zonedInstant,
} from "@/lib/explore-calendar";
import { EXPLORE_RANGES, type ExploreQuery, type ExploreRange, MAX_RANGE_MS, isCustom, parseDuration, rangeMs, rangeText, rangeWords } from "@/lib/explore-query";
import { zoneLabel } from "@/lib/time-zone";
import { useTimeZone } from "@/lib/time-zone-context";
import { Icon } from "../icons";

export type RangePick = { range: ExploreRange; from?: string; to?: string };

/** The gap between the trigger and the popover (Radix Popover's sideOffset 4). */
const POP_GAP = 4;
/** How long "Copied!" / "Pasted!" stays on the Copy range button (Logs.DatePickers.tsx). */
const SAID_MS = 2000;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The Time Range facet (Supabase Unified Logs' first sidebar filter, DataTableFilterTimerange in
 * its `h-8` block button): a collapsible section holding one full-width bordered button, a clock
 * and the range (`Last 60 minutes`), that opens the date picker under it. The range lives only
 * here: the filter box takes `time:2h` but shows no pill for it.
 */
export function TimeRangeFacet({ query, onRange, open, onToggle }: { query: ExploreQuery; onRange: (r: RangePick) => void; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <section className={`exf-facet${open ? " is-open" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="exf-facet__head">
        <h3 className="exf-facet__title" id={`${id}-h`}>
          <button type="button" aria-expanded={open} aria-controls={`${id}-b`} onClick={onToggle}>
            <span className="exf-facet__name">Time Range</span>
            <Icon name="chevronDown" />
          </button>
        </h3>
      </div>
      {open ? (
        <div className="exf-facet__body" id={`${id}-b`}>
          <TimeRangeButton query={query} onRange={onRange} />
        </div>
      ) : null}
    </section>
  );
}

function TimeRangeButton({ query: q, onRange }: { query: ExploreQuery; onRange: (r: RangePick) => void }) {
  const tz = useTimeZone();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const text = rangeText(q, tz);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ext-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-pop` : undefined}
        aria-label={`Time range: ${text}`}
        title={text}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="clock" />
        <span className="ext-trigger__text">{text}</span>
      </button>
      {open ? (
        <Popover id={`${id}-pop`} anchor={trigger} onClose={close}>
          <DatePicker
            query={q}
            tz={tz}
            onPick={(r) => {
              close();
              onRange(r);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}

/**
 * Radix's Popover as Supabase uses it here (`side="bottom" align="start"`, sideOffset 4): portalled
 * to <body>, under its trigger and left-aligned with it, kept inside the viewport. Focus moves in
 * on open and is trapped (Tab cycles), Escape and an outside click close it.
 */
function Popover({ id, anchor, onClose, children }: { id: string; anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      const el = box.current;
      if (!r || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const below = r.bottom + POP_GAP;
      const top = below + h > window.innerHeight - 8 && r.top - POP_GAP - h > 8 ? r.top - POP_GAP - h : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  // The relative-range box takes focus first, as in Supabase's picker (once placed and visible).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>("input")?.focus();
  }, [placed]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [anchor, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={box}
      id={id}
      className="ah ext-pop"
      role="dialog"
      aria-modal="true"
      aria-label="Time range"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Supabase's LogsDatePicker (Logs.DatePickers.tsx:295-428): on the left a `e.g. 2h, 30m, 7d` box
 * over the relative ranges; on the right the start and end times (HH : MM : SS, TimeSplitInput)
 * with a reset, the month calendar in range mode, and Copy range, Today and Apply. Times are in
 * the viewer's zone (useTimeZone). Only what the API reads is offered: up to the last 7 days.
 */
function DatePicker({ query: q, tz, onPick }: { query: ExploreQuery; tz: string; onPick: (r: RangePick) => void }) {
  const id = useId();
  const [now] = useState(() => Date.now());
  const [custom, setCustom] = useState("");
  const start0 = zonedDayTime(q.from ? Date.parse(q.from) : (q.to ? Date.parse(q.to) : now) - rangeMs(q.range), tz);
  const end0 = zonedDayTime(q.to ? Date.parse(q.to) : now, tz);
  const [startTime, setStartTime] = useState<TimeParts>(start0.time);
  const [endTime, setEndTime] = useState<TimeParts>(end0.time);
  const [days, setDays] = useState<{ from: DayKey | null; to: DayKey | null }>({ from: start0.day, to: end0.day });
  const [month, setMonth] = useState<DayKey>(end0.day);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<"copied" | "pasted" | null>(null);
  const today = zonedDayTime(now, tz).day;
  const minDay = zonedDayTime(now - MAX_RANGE_MS, tz).day;

  useEffect(() => {
    if (!said) return;
    const t = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(t);
  }, [said]);

  // Typing a duration offers it alone (`Last 2 hours`); empty lists the presets.
  const typed = custom.trim() ? parseDuration(custom) : null;
  const helpers: { key: string; text: string; range: ExploreRange; on: boolean }[] = custom.trim()
    ? typed
      ? [{ key: "typed", text: typed.words, range: typed.range, on: false }]
      : []
    : EXPLORE_RANGES.map((r) => ({ key: r, text: `Last ${rangeWords(r)}`, range: r, on: !isCustom(q) && q.range === r }));
  const checked = Math.max(0, helpers.findIndex((h) => h.on));

  const window_ = () => {
    if (!days.from) return null;
    const a = zonedInstant(days.from, startTime, tz);
    const b = zonedInstant(days.to ?? days.from, endTime, tz);
    return a && b ? { from: a, to: b } : null;
  };

  const apply = () => {
    const w = window_();
    if (!w) return setErr("Pick a day and enter both times.");
    const a = Date.parse(w.from);
    const b = Date.parse(w.to);
    if (a >= b) return setErr("The start must be before the end.");
    const at = Date.now();
    if (a < at - MAX_RANGE_MS) return setErr("Explore reads the last 7 days. Pick a start inside them.");
    if (a >= at) return setErr("The start is in the future.");
    // An end at or after now keeps the window live (a start only).
    onPick({ range: q.range, from: w.from, ...(b < at ? { to: w.to } : {}) });
  };

  const copy = async () => {
    const w = window_();
    if (!w) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(w));
      setSaid("copied");
    } catch {
      setErr("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };

  // Pasting a copied range (`{"from": …, "to": …}`) anywhere outside the inputs fills it in.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    try {
      const v = JSON.parse(e.clipboardData.getData("text")) as { from?: unknown; to?: unknown };
      const a = typeof v.from === "string" ? Date.parse(v.from) : Number.NaN;
      const b = typeof v.to === "string" ? Date.parse(v.to) : Number.NaN;
      if (Number.isNaN(a) || Number.isNaN(b)) return;
      e.preventDefault();
      const s = zonedDayTime(a, tz);
      const t = zonedDayTime(b, tz);
      setDays({ from: s.day, to: t.day });
      setStartTime(s.time);
      setEndTime(t.time);
      setMonth(t.day);
      setSaid("pasted");
      setErr(null);
    } catch {}
  };

  const onHelperKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
    list?.[(i + (e.key === "ArrowDown" ? 1 : -1) + helpers.length) % helpers.length]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: paste of a copied range, as Supabase's document listener.
    <div className="ext" onPaste={onPaste}>
      <div className="ext-helpers">
        <input
          className="ext-custom"
          type="text"
          placeholder="e.g. 2h, 30m, 7d"
          aria-label="Relative range, for example 2h, 30m or 7d"
          value={custom}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && helpers[0]) {
              e.preventDefault();
              onPick({ range: helpers[0].range });
            }
          }}
        />
        <div role="radiogroup" aria-label="Relative ranges" className="ext-list">
          {helpers.map((h, i) => (
            <button
              key={h.key}
              type="button"
              role="radio"
              aria-checked={h.on}
              tabIndex={i === checked ? 0 : -1}
              className="ext-helper"
              onKeyDown={(e) => onHelperKey(e, i)}
              onClick={() => onPick({ range: h.range })}
            >
              {h.text}
            </button>
          ))}
          {helpers.length === 0 ? <p className="ext-invalid">Invalid format. Try 2h, 30m, or 7d.</p> : null}
        </div>
      </div>
      <div className="ext-main">
        <div className="ext-times">
          <TimeSplit label={`Start time (${zoneLabel(tz)})`} value={startTime} onChange={(t) => (setStartTime(t), setErr(null))} />
          <TimeSplit label={`End time (${zoneLabel(tz)})`} value={endTime} onChange={(t) => (setEndTime(t), setErr(null))} />
          <button
            type="button"
            className="ext-reset"
            aria-label="Reset times to the whole day"
            title="Reset times to the whole day"
            onClick={() => {
              setStartTime({ hh: "00", mm: "00", ss: "00" });
              setEndTime({ hh: "23", mm: "59", ss: "59" });
              setErr(null);
            }}
          >
            <Icon name="history" />
          </button>
        </div>
        <Calendar
          month={month}
          onMonth={setMonth}
          days={days}
          minDay={minDay}
          maxDay={today}
          onPick={(d) => {
            setDays((r) => pickDay(r, d));
            setErr(null);
          }}
        />
        {err ? (
          <p className="ext-err" role="alert" id={`${id}-err`}>
            {err}
          </p>
        ) : null}
        <div className="ext-foot">
          {days.from ? (
            <button type="button" className={`ah-btn ah-btn--ghost ah-btn--sm ext-btn${said ? " is-said" : ""}`} onClick={copy}>
              {said === "copied" ? "Copied!" : said === "pasted" ? "Pasted!" : "Copy range"}
            </button>
          ) : null}
          <button
            type="button"
            className="ah-btn ah-btn--outline ah-btn--sm ext-btn"
            onClick={() => {
              setMonth(today);
              setDays({ from: today, to: today });
              setErr(null);
            }}
          >
            Today
          </button>
          <button type="button" className="ah-btn ah-btn--primary ah-btn--sm ext-btn" onClick={apply} aria-describedby={err ? `${id}-err` : undefined}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Supabase's TimeSplitInput: one bordered box of `HH : MM : SS`, each part its own two-digit
 * input. Typing two digits moves to the next part, ↑/↓ step a part (wrapping), Backspace in an
 * empty part goes back.
 */
function TimeSplit({ label, value, onChange }: { label: string; value: TimeParts; onChange: (t: TimeParts) => void }) {
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const parts = [
    { k: "hh", max: 23, name: "hours" },
    { k: "mm", max: 59, name: "minutes" },
    { k: "ss", max: 59, name: "seconds" },
  ] as const;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and borders of its own.
    <div className="ext-split" role="group" aria-label={label} title={label}>
      {parts.map((p, i) => (
        <span key={p.k} className="ext-split__part">
          {i ? (
            <span className="ext-split__sep" aria-hidden="true">
              :
            </span>
          ) : null}
          <input
            ref={refs[i]}
            className="ext-split__input"
            type="text"
            inputMode="numeric"
            maxLength={2}
            aria-label={`${label}, ${p.name}`}
            value={value[p.k]}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const v = clampPart(e.target.value, p.max);
              onChange({ ...value, [p.k]: v });
              if (v.length === 2 && i < 2) refs[i + 1].current?.focus();
            }}
            onBlur={() => onChange({ ...value, [p.k]: padPart(value[p.k]) })}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                onChange({ ...value, [p.k]: stepPart(value[p.k], e.key === "ArrowUp" ? 1 : -1, p.max) });
              } else if (e.key === "Backspace" && !value[p.k] && i > 0) {
                e.preventDefault();
                refs[i - 1].current?.focus();
              }
            }}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * packages/ui's Calendar (react-day-picker) in range mode: `‹ Month YYYY ›`, the Su–Sa header and
 * the month's weeks; the picked days filled with the accent, the days between tinted, days of the
 * months around dim. A grid with one focusable day: arrows move a day or a week, Home/End the
 * week's ends, PageUp/PageDown a month (Shift: a year), Enter or Space picks. Days the API cannot
 * read (older than 7 days, or after today) are disabled.
 */
function Calendar({
  month,
  onMonth,
  days,
  minDay,
  maxDay,
  onPick,
}: {
  month: DayKey;
  onMonth: (d: DayKey) => void;
  days: { from: DayKey | null; to: DayKey | null };
  minDay: DayKey;
  maxDay: DayKey;
  onPick: (d: DayKey) => void;
}) {
  const id = useId();
  const m = keyParts(month);
  const grid = monthGrid(m.year, m.month);
  const inMonth = (d: DayKey) => {
    const p = keyParts(d);
    return p.year === m.year && p.month === m.month;
  };
  const clamp = (d: DayKey) => (d < minDay ? minDay : d > maxDay ? maxDay : d);
  const pickFocus = () => {
    const want = days.to ?? days.from ?? maxDay;
    if (inMonth(want)) return clamp(want);
    const first = `${month.slice(0, 8)}01`;
    return clamp(inMonth(maxDay) ? maxDay : first);
  };
  const [focus, setFocus] = useState<DayKey>(pickFocus);
  const moved = useRef(false);
  const table = useRef<HTMLTableElement>(null);
  const shown = inMonth(focus) ? focus : pickFocus();

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    table.current?.querySelector<HTMLButtonElement>(`button[data-day="${shown}"]`)?.focus();
  });

  const lo = days.from;
  const hi = days.to ?? days.from;
  const go = (n: number) => {
    const next = addMonths(month, n);
    onMonth(next);
    setFocus(clamp(next));
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, d: DayKey) => {
    const next = moveDay(d, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    const c = clamp(next);
    moved.current = true;
    setFocus(c);
    if (!inMonth(c)) onMonth(c);
  };

  return (
    <div className="extc">
      <div className="extc-head">
        <button type="button" className="extc-nav" aria-label="Previous month" disabled={addDays(`${month.slice(0, 8)}01`, -1) < minDay} onClick={() => go(-1)}>
          <Icon name="chevronLeft" />
        </button>
        <p className="extc-title" id={`${id}-m`} aria-live="polite">
          {MONTHS[m.month]} {m.year}
        </p>
        <button type="button" className="extc-nav" aria-label="Next month" disabled={addMonths(`${month.slice(0, 8)}01`, 1) > maxDay} onClick={() => go(1)}>
          <Icon name="chevronRight" />
        </button>
      </div>
      <table ref={table} className="extc-grid" role="grid" aria-labelledby={`${id}-m`}>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} scope="col" className="extc-wd" abbr={w}>
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week) => (
            <tr key={week[0].key}>
              {week.map((d) => {
                const disabled = d.key < minDay || d.key > maxDay;
                const end = d.key === lo || d.key === hi;
                const between = lo !== null && hi !== null && d.key > lo && d.key < hi;
                const cls = `extc-day${d.outside ? " is-outside" : ""}${end ? " is-end" : ""}${between ? " is-between" : ""}${d.key === maxDay ? " is-today" : ""}`;
                return (
                  <td key={d.key} role="gridcell" aria-selected={end || between}>
                    <button
                      type="button"
                      className={cls}
                      data-day={d.key}
                      tabIndex={d.key === shown ? 0 : -1}
                      disabled={disabled}
                      aria-label={dayLabel(d.key)}
                      aria-current={d.key === maxDay ? "date" : undefined}
                      onFocus={() => setFocus(d.key)}
                      onKeyDown={(e) => onKey(e, d.key)}
                      onClick={() => onPick(d.key)}
                    >
                      {d.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
