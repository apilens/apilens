"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import { EXPLORE_RANGES, type ExploreQuery, type ExploreRange, RANGE_MS, RANGE_WORDS, isCustom, isoToZonedInput, rangeText, zonedInputToIso } from "@/lib/explore-query";
import { zoneLabel } from "@/lib/time-zone";
import { useTimeZone } from "@/lib/time-zone-context";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";

/**
 * Explore's range picker (#1052): the last 15 minutes to 7 days, each ending now (1 hour by
 * default), or a custom from–to in the viewer's time zone.
 */
export function RangeMenu({ query: q, onRange }: { query: ExploreQuery; onRange: (r: { range: ExploreRange; from?: string; to?: string }) => void }) {
  const tz = useTimeZone();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const openCustom = () => {
    const now = Date.now();
    setFrom(isoToZonedInput(q.from ?? new Date(now - RANGE_MS[q.range]).toISOString(), tz));
    setTo(isoToZonedInput(q.to ?? new Date(now).toISOString(), tz));
    setErr(null);
    setCustom(true);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = zonedInputToIso(from, tz);
    const b = zonedInputToIso(to, tz);
    if (!a || !b) return setErr("Enter both times.");
    if (Date.parse(a) >= Date.parse(b)) return setErr("The start must be before the end.");
    if (Date.parse(a) < Date.now() - RANGE_MS["7d"]) return setErr("Explore reads the last 7 days; pick a start inside them.");
    setOpen(false);
    onRange({ range: q.range, from: a, to: b });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ex-tbtn exr-range"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Time range: ${rangeText(q, tz)}`}
        onClick={() => {
          setCustom(false);
          setOpen((o) => !o);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="ex-tbtn__icon">
          <circle cx="8" cy="8" r="5.75" />
          <path d="M8 4.75V8l2.25 1.5" />
        </svg>
        <span className="exr-range__text">{isCustom(q) ? rangeText(q, tz) : `Last ${q.range}`}</span>
        <Icon name="chevronDown" />
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={trigger} label="Time range" role={custom ? "dialog" : "menu"} id={`${id}-menu`}>
        {custom ? (
          <form className="ex-views__form" onSubmit={submit} noValidate>
            <label htmlFor={`${id}-from`}>From ({zoneLabel(tz)})</label>
            <input id={`${id}-from`} className="ex-input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            <label htmlFor={`${id}-to`}>To ({zoneLabel(tz)})</label>
            <input id={`${id}-to`} className="ex-input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            {err ? (
              <p className="ex-error" role="alert">
                {err}
              </p>
            ) : null}
            <div className="ex-views__actions">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setCustom(false)}>
                Back
              </button>
              <button type="submit" className="ah-btn ah-btn--primary ah-btn--sm">
                Apply range
              </button>
            </div>
          </form>
        ) : (
          <>
            {EXPLORE_RANGES.map((r) => {
              const on = !isCustom(q) && q.range === r;
              return (
                <button
                  key={r}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="cp-sitem"
                  onClick={() => {
                    setOpen(false);
                    onRange({ range: r });
                  }}
                >
                  <span className="lb">Last {RANGE_WORDS[r]}</span>
                  {on ? (
                    <span className="sl">
                      <Icon name="check" />
                    </span>
                  ) : null}
                </button>
              );
            })}
            <hr />
            <button type="button" role="menuitemradio" aria-checked={isCustom(q)} aria-haspopup="dialog" className="cp-sitem" onClick={openCustom}>
              <span className="lb">Custom range…</span>
              {isCustom(q) ? (
                <span className="sl">
                  <Icon name="check" />
                </span>
              ) : null}
            </button>
          </>
        )}
      </PopMenu>
    </>
  );
}
