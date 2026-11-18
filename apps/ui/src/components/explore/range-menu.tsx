"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import {
  EXPLORE_RANGES,
  type ExploreQuery,
  type ExploreRange,
  DEFAULT_RANGE,
  RANGE_MS,
  RANGE_WORDS,
  isCustom,
  isoToZonedInput,
  parseDuration,
  presetOf,
  rangeText,
  zonedInputToIso,
} from "@/lib/explore-query";
import { isoSecond } from "@/lib/explore-timeline";
import { zoneLabel } from "@/lib/time-zone";
import { useTimeZone } from "@/lib/time-zone-context";
import { PopMenu } from "../pop-menu";

export type RangePick = { range: ExploreRange; from?: string; to?: string };

/**
 * The time range inside the filter box (#1061), as Supabase's Unified Logs keeps it: a
 * `Time range · Last 1 hour` condition at the box's leading edge (FilterCondition.tsx:278-283,
 * pill variant: 26px, rounded-sm, border, muted background) whose value opens Supabase's
 * LogsDatePicker (Logs.DatePickers.tsx:295-428): on the left a "e.g. 2h, 30m, 7d" box over the
 * relative ranges, on the right the start and end in the viewer's zone with Apply. Its × goes back
 * to the default (the last hour). `time:2h` / `date:24h` typed in the box do the same (pill-bar).
 */
export function TimePill({ query: q, onRange }: { query: ExploreQuery; onRange: (r: RangePick) => void }) {
  const tz = useTimeZone();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const isDefault = !isCustom(q) && q.range === DEFAULT_RANGE;
  const text = rangeText(q, tz);

  return (
    <li className="exp-pill exp-pill--time">
      <button
        ref={trigger}
        type="button"
        className="exp-pill__body"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Time range: ${text}`}
        title={text}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="exp-pill__field">Time range</span>
        <span className="exp-pill__op">=</span>
        <span className="exp-pill__value">{text}</span>
      </button>
      {isDefault ? null : (
        <button type="button" className="exp-pill__x" aria-label="Reset the time range to the last hour" onClick={() => onRange({ range: DEFAULT_RANGE })}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      )}
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Time range" role="dialog" id={`${id}-pop`}>
        {open ? (
          <DatePicker
            query={q}
            tz={tz}
            onPick={(r) => {
              setOpen(false);
              onRange(r);
            }}
          />
        ) : null}
      </PopMenu>
    </li>
  );
}

/** Supabase's LogsDatePicker content (Logs.DatePickers.tsx:295-428), without the calendar. */
function DatePicker({ query: q, tz, onPick }: { query: ExploreQuery; tz: string; onPick: (r: RangePick) => void }) {
  const id = useId();
  const [custom, setCustom] = useState("");
  const now = Date.now();
  const [from, setFrom] = useState(() => isoToZonedInput(q.from ?? new Date(now - RANGE_MS[q.range]).toISOString(), tz));
  const [to, setTo] = useState(() => isoToZonedInput(q.to ?? new Date(now).toISOString(), tz));
  const [err, setErr] = useState<string | null>(null);

  // Typing a duration offers it alone (`Last 2 hours`); empty shows the presets.
  const typed = custom.trim() ? parseDuration(custom) : null;
  const helpers: { key: string; text: string; pick: RangePick; on: boolean }[] = custom.trim()
    ? typed
      ? [{ key: "typed", text: typed.words, pick: presetOf(typed.ms) ? { range: presetOf(typed.ms) as ExploreRange } : { range: DEFAULT_RANGE, from: isoSecond(Date.now() - typed.ms) }, on: false }]
      : []
    : EXPLORE_RANGES.map((r) => ({ key: r, text: `Last ${RANGE_WORDS[r]}`, pick: { range: r }, on: !isCustom(q) && q.range === r }));

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const a = zonedInputToIso(from, tz);
    const b = zonedInputToIso(to, tz);
    if (!a || !b) return setErr("Enter both times.");
    if (Date.parse(a) >= Date.parse(b)) return setErr("The start must be before the end.");
    if (Date.parse(a) < Date.now() - RANGE_MS["7d"]) return setErr("Explore reads the last 7 days; pick a start inside them.");
    onPick({ range: q.range, from: a, to: b });
  };

  return (
    <div className="ext">
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
              onPick(helpers[0].pick);
            }
          }}
        />
        <div role="radiogroup" aria-label="Relative ranges" className="ext-list">
          {helpers.map((h) => (
            <button key={h.key} type="button" role="radio" aria-checked={h.on} className="ext-helper" onClick={() => onPick(h.pick)}>
              {h.text}
            </button>
          ))}
          {helpers.length === 0 ? <p className="ext-invalid">Invalid format. Try 2h, 30m, or 7d.</p> : null}
        </div>
      </div>
      <form className="ext-abs" onSubmit={apply} noValidate>
        <div className="ext-times">
          <label htmlFor={`${id}-from`}>
            Start <span className="ext-zone">{zoneLabel(tz)}</span>
          </label>
          <input id={`${id}-from`} className="ext-time" type="datetime-local" value={from} onChange={(e) => (setFrom(e.target.value), setErr(null))} />
          <label htmlFor={`${id}-to`}>
            End <span className="ext-zone">{zoneLabel(tz)}</span>
          </label>
          <input id={`${id}-to`} className="ext-time" type="datetime-local" value={to} onChange={(e) => (setTo(e.target.value), setErr(null))} />
        </div>
        {err ? (
          <p className="ext-err" role="alert">
            {err}
          </p>
        ) : null}
        <div className="ext-foot">
          <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm ex-tbtn">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
