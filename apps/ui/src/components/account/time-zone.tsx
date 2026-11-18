"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { saveTimeZone } from "@/app/settings/profile-actions";
import { DEFAULT_TIME_ZONE, type TimeZoneOption, browserTimeZone, matchesZone, timeZoneOptions, zoneLabel, zoned } from "@/lib/time-zone";
import { ObIcon } from "../onboarding/ob";

type Status = { tone: "ok" | "err"; text: string } | null;

/** Options rendered at once; typing narrows the rest. */
const SHOWN = 60;
const CLOCK = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

function describe(tz: string): string {
  const o = timeZoneOptions().find((x) => x.value === tz);
  const name = o ? (o.region ? `${o.city} (${o.region})` : o.city) : tz;
  const label = zoneLabel(tz);
  return o && label !== o.gmt && tz !== DEFAULT_TIME_ZONE ? `${name} · ${label}, ${o.gmt}` : `${name} · ${label}`;
}

/**
 * `/settings` Profile → Time zone (#1046): the zone every time in the dashboard is shown in. UTC
 * until the user picks one. Saving refreshes the pages, so the change shows everywhere at once.
 */
export function TimeZoneCard({ initial }: { initial: string }) {
  const [saved, setSaved] = useState(initial || DEFAULT_TIME_ZONE);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<Status>(null);
  const [pending, start] = useTransition();
  // Browser-only values, read after mount so the server and browser render the same HTML.
  const [browser, setBrowser] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    setBrowser(browserTimeZone());
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const matches = useMemo<TimeZoneOption[]>(() => timeZoneOptions().filter((o) => matchesZone(o, query)), [query]);
  const shown = matches.slice(0, SHOWN);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const pick = (tz: string) => {
    if (pending) return;
    if (tz === saved) {
      close();
      return;
    }
    start(async () => {
      const result = await saveTimeZone(tz === DEFAULT_TIME_ZONE ? "" : tz);
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        return;
      }
      setSaved(tz);
      close();
      setStatus({ tone: "ok", text: `Times now show in ${zoneLabel(tz)}.` });
    });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o.value);
    } else if (e.key === "Escape") {
      close();
    }
  };

  const suggest = browser && browser !== saved ? browser : null;

  return (
    <section className="os-card" aria-labelledby={`${id}-h`}>
      <div className="os-card__head">
        <h2 id={`${id}-h`}>Time zone</h2>
        <p>Request logs, traces, charts and settings show times in this zone.</p>
      </div>
      <div className="os-card__body">
        <div className="ob-f">
          <span className="ob-l" id={`${id}-l`}>
            Time zone{saved === DEFAULT_TIME_ZONE ? <small>default</small> : null}
          </span>
          <div className="ob-in ro" aria-labelledby={`${id}-l`}>
            <ObIcon name="clock" />
            <span className="val ac-val">{describe(saved)}</span>
            {now !== null ? <span className="ac-tz-now">{`${zoned("en-US", CLOCK, saved).format(now)} now`}</span> : null}
            {!open ? (
              <button
                type="button"
                className="ah-btn ah-btn--ghost ah-btn--sm os-copy"
                onClick={() => {
                  setStatus(null);
                  setOpen(true);
                }}
                aria-label={`Change time zone, now ${describe(saved)}`}
              >
                Change
              </button>
            ) : null}
          </div>
        </div>

        {!open && (suggest || saved !== DEFAULT_TIME_ZONE) ? (
          <div className="ac-tz-quick">
            {suggest ? (
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => pick(suggest)} disabled={pending}>
                Use this browser’s time zone ({describe(suggest)})
              </button>
            ) : null}
            {saved !== DEFAULT_TIME_ZONE ? (
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => pick(DEFAULT_TIME_ZONE)} disabled={pending}>
                Back to UTC
              </button>
            ) : null}
          </div>
        ) : null}

        {open ? (
          <div className="os-confirm ac-tz">
            <p>
              <label htmlFor={`${id}-q`}>Search by city, region or offset</label>
            </p>
            <div className="ob-in">
              <ObIcon name="search" />
              <input
                ref={field}
                id={`${id}-q`}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={shown[active] ? `${id}-o${active}` : undefined}
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                placeholder="Kolkata, Berlin, +5:30, PST"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </div>
            <ul ref={list} id={`${id}-list`} className="ac-tz-list" role="listbox" aria-label="Time zones">
              {shown.map((o, i) => (
                <li
                  key={o.value}
                  id={`${id}-o${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === saved}
                  className={`${i === active ? "is-active" : ""}${o.value === saved ? " is-current" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.value)}
                >
                  <span className="ac-tz-city">{o.city}</span>
                  <span className="ac-tz-region">{o.region}</span>
                  <span className="ac-tz-off">
                    {zoneLabel(o.value) !== o.gmt && o.value !== DEFAULT_TIME_ZONE ? `${zoneLabel(o.value)} · ` : ""}
                    {o.gmt}
                  </span>
                </li>
              ))}
              {shown.length === 0 ? <li className="ac-tz-empty">No time zone matches “{query.trim()}”.</li> : null}
            </ul>
            {matches.length > SHOWN ? <p className="os-help">{`Showing ${SHOWN} of ${matches.length}. Keep typing to narrow it down.`}</p> : null}
            <div className="row">
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
      </div>
    </section>
  );
}
