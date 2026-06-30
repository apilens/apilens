"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/* Shared time-range picker used by Traffic, Request logs, etc.
   A range is either a named preset (rolling window or calendar-aligned) or a
   user-defined custom window. `resolveRange` turns either into a concrete
   { since, until } pair plus the span (used for bucket labelling + RPM). */

export type RangeValue =
  | { type: "preset"; id: string }
  | { type: "custom"; since: string; until: string };

export interface ResolvedRange {
  since: string;
  until: string;
  spanHours: number;
  label: string;
}

// Rolling windows ending "now".
export const ROLLING_PRESETS = [
  { id: "1h", label: "Last hour", hours: 1 },
  { id: "6h", label: "Last 6 hours", hours: 6 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 168 },
  { id: "30d", label: "Last 30 days", hours: 720 },
  { id: "90d", label: "Last 90 days", hours: 2160 },
] as const;

// Calendar-aligned windows (local time).
export const CALENDAR_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
] as const;

export const DEFAULT_PRESET_ID = "24h";
export const DEFAULT_RANGE: RangeValue = { type: "preset", id: DEFAULT_PRESET_ID };

// Reconstruct the range from URL params: custom (since+until) wins, else a known
// preset id, else the default.
export function parseRange(f?: { range?: string; since?: string; until?: string }): RangeValue {
  if (f?.since && f?.until) return { type: "custom", since: f.since, until: f.until };
  if (f?.range) {
    const known = [...ROLLING_PRESETS, ...CALENDAR_PRESETS].some((p) => p.id === f.range);
    if (known) return { type: "preset", id: f.range };
  }
  return DEFAULT_RANGE;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function resolveRange(value: RangeValue): ResolvedRange {
  const now = new Date();
  const spanOf = (since: Date, until: Date) =>
    Math.max(1 / 60, (until.getTime() - since.getTime()) / 3_600_000);

  if (value.type === "custom") {
    const since = new Date(value.since);
    const until = new Date(value.until);
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      spanHours: spanOf(since, until),
      label: customLabel(since, until),
    };
  }

  const rolling = ROLLING_PRESETS.find((p) => p.id === value.id);
  if (rolling) {
    const since = new Date(now.getTime() - rolling.hours * 3_600_000);
    return { since: since.toISOString(), until: now.toISOString(), spanHours: rolling.hours, label: rolling.label };
  }

  // Calendar presets.
  let since: Date;
  let until = now;
  switch (value.id) {
    case "yesterday": {
      const todayStart = startOfDay(now);
      since = new Date(todayStart.getTime() - 86_400_000);
      until = todayStart;
      break;
    }
    case "this_week": {
      const s = startOfDay(now);
      const dow = (s.getDay() + 6) % 7; // Monday = 0
      since = new Date(s.getTime() - dow * 86_400_000);
      break;
    }
    case "this_month":
      since = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "today":
    default:
      since = startOfDay(now);
      break;
  }
  const label = CALENDAR_PRESETS.find((p) => p.id === value.id)?.label ?? "Today";
  return { since: since.toISOString(), until: until.toISOString(), spanHours: spanOf(since, until), label };
}

function customLabel(since: Date, until: Date): string {
  const sameDay = since.toDateString() === until.toDateString();
  const d = (x: Date) => x.toLocaleDateString([], { month: "short", day: "numeric" });
  const t = (x: Date) => x.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `${d(since)}, ${t(since)} – ${t(until)}` : `${d(since)} – ${d(until)}`;
}

// ISO ⇄ <input type="datetime-local"> value (which is local, no timezone).
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

export function TimeRangePicker({
  value,
  resolved,
  onChange,
}: {
  value: RangeValue;
  resolved: ResolvedRange;
  onChange: (v: RangeValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(resolved.since));
  const [to, setTo] = useState(() => toLocalInput(resolved.until));
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onClickOutside);
      return () => document.removeEventListener("mousedown", onClickOutside);
    }
  }, [open]);

  // Seed the custom inputs from the live window each time the menu opens.
  useEffect(() => {
    if (open) {
      setFrom(toLocalInput(resolved.since));
      setTo(toLocalInput(resolved.until));
      setError("");
    }
  }, [open, resolved.since, resolved.until]);

  const isPreset = (id: string) => value.type === "preset" && value.id === id;

  const pickPreset = (id: string) => {
    onChange({ type: "preset", id });
    setOpen(false);
  };

  const applyCustom = () => {
    if (!from || !to) {
      setError("Pick a start and end time.");
      return;
    }
    const sinceMs = new Date(from).getTime();
    const untilMs = new Date(to).getTime();
    if (isNaN(sinceMs) || isNaN(untilMs)) {
      setError("Invalid date.");
      return;
    }
    if (sinceMs >= untilMs) {
      setError("Start must be before end.");
      return;
    }
    onChange({ type: "custom", since: fromLocalInput(from), until: fromLocalInput(to) });
    setOpen(false);
  };

  return (
    <div className="tf-range" ref={ref}>
      <button
        type="button"
        className="tf-range-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="tf-range-label">{resolved.label}</span>
        <ChevronDown size={14} className="tf-range-chev" />
      </button>

      {open && (
        <div className="tf-range-menu" role="dialog" aria-label="Select time range">
          <div className="tf-range-presets">
            <p className="tf-range-heading">Quick ranges</p>
            {ROLLING_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`tf-range-opt${isPreset(p.id) ? " active" : ""}`}
                onClick={() => pickPreset(p.id)}
              >
                <span>{p.label}</span>
                {isPreset(p.id) && <Check size={13} />}
              </button>
            ))}
            <div className="tf-range-divider" />
            <p className="tf-range-heading">Calendar</p>
            {CALENDAR_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`tf-range-opt${isPreset(p.id) ? " active" : ""}`}
                onClick={() => pickPreset(p.id)}
              >
                <span>{p.label}</span>
                {isPreset(p.id) && <Check size={13} />}
              </button>
            ))}
          </div>

          <div className="tf-range-custom">
            <p className="tf-range-heading">
              Custom range
              {value.type === "custom" && <span className="tf-range-active-pill">Active</span>}
            </p>
            <label className="tf-range-field">
              <span>From</span>
              <input
                type="datetime-local"
                className="tf-range-input"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="tf-range-field">
              <span>To</span>
              <input
                type="datetime-local"
                className="tf-range-input"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            {error && <p className="tf-range-error">{error}</p>}
            <button type="button" className="tf-range-apply" onClick={applyCustom}>
              Apply custom range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
