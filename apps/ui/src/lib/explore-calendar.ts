// The calendar and the HH : MM : SS inputs of Explore's time range picker (after Supabase's
// LogsDatePicker: packages/ui Calendar in range mode and apps/studio DatePicker/TimeSplitInput).
// Days are calendar dates in the viewer's time zone (`useTimeZone()`), kept as `YYYY-MM-DD` keys
// so no browser-local Date arithmetic leaks in. Pure; unit-tested in explore-calendar.test.ts.
import { zonedInputToIso } from "./explore-query";
import { zonedParts } from "./time-zone";

/** A calendar date, `YYYY-MM-DD`. */
export type DayKey = string;
/** A wall-clock time, each part two digits. */
export interface TimeParts {
  hh: string;
  mm: string;
  ss: string;
}
/** One cell of the month grid. */
export interface GridDay {
  key: DayKey;
  day: number;
  /** In the month before or after the one shown (drawn dim). */
  outside: boolean;
}

export const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The key of a year, a 0-based month and a day (out-of-range parts roll over, as Date.UTC does). */
export function dayKey(year: number, month: number, day: number): DayKey {
  const d = new Date(Date.UTC(year, month, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The year, 0-based month and day of a key. */
export function keyParts(key: DayKey): { year: number; month: number; day: number } {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`not a day: ${key}`);
  return { year: +m[1], month: +m[2] - 1, day: +m[3] };
}

/** `key` moved by `n` days. */
export function addDays(key: DayKey, n: number): DayKey {
  const p = keyParts(key);
  return dayKey(p.year, p.month, p.day + n);
}

/** The same day `n` months on, clamped to the target month's length (Jan 31 + 1 month is Feb 28). */
export function addMonths(key: DayKey, n: number): DayKey {
  const p = keyParts(key);
  const first = keyParts(dayKey(p.year, p.month + n, 1));
  const last = keyParts(dayKey(first.year, first.month + 1, 0)).day;
  return dayKey(first.year, first.month, Math.min(p.day, last));
}

/** The weekday of a key, 0 Sunday to 6 Saturday. */
export const weekday = (key: DayKey) => {
  const p = keyParts(key);
  return new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay();
};

/**
 * The month's grid, weeks from Sunday, as react-day-picker draws it: only the weeks the month
 * touches (4 to 6), padded with the days of the months around it.
 */
export function monthGrid(year: number, month: number): GridDay[][] {
  const first = dayKey(year, month, 1);
  const days = keyParts(dayKey(year, month + 1, 0)).day;
  const lead = weekday(first);
  const weeks = Math.ceil((lead + days) / 7);
  const out: GridDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const row: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      const key = addDays(first, w * 7 + i - lead);
      const p = keyParts(key);
      row.push({ key, day: p.day, outside: p.month !== month || p.year !== year });
    }
    out.push(row);
  }
  return out;
}

/** The day and time of an instant in `tz`. */
export function zonedDayTime(at: number, tz: string): { day: DayKey; time: TimeParts } {
  const p = zonedParts(at, tz);
  return { day: dayKey(p.year, p.month, p.day), time: { hh: pad(p.hour), mm: pad(p.minute), ss: pad(p.second) } };
}

/** The instant of a day and a wall time in `tz` (ISO, whole seconds), or null when a part is not a number. */
export function zonedInstant(day: DayKey, t: TimeParts, tz: string): string | null {
  if (![t.hh, t.mm, t.ss].every((v) => /^\d{1,2}$/.test(v))) return null;
  return zonedInputToIso(`${day}T${pad(+t.hh)}:${pad(+t.mm)}:${pad(+t.ss)}`, tz);
}

/**
 * A typed time part kept to its digits and range: at most two digits, at most `max` (23 for hours,
 * 59 otherwise). Empty stays empty while typing.
 */
export function clampPart(raw: string, max: number): string {
  const digits = raw.replace(/\D/g, "").slice(-2);
  if (!digits) return "";
  return String(Math.min(max, Number(digits))).padStart(digits.length, "0");
}

/** A part as shown once its input loses focus: two digits (empty reads as 00). */
export const padPart = (v: string) => pad(Number(v) || 0);

/** A part moved by `delta` with ↑/↓, wrapping within 0..max. */
export function stepPart(v: string, delta: number, max: number): string {
  const n = ((Number(v) || 0) + delta + (max + 1)) % (max + 1);
  return pad(n);
}

/** The day a keyboard key moves the calendar's focus to, or null for any other key. */
export function moveDay(key: DayKey, k: string, shift = false): DayKey | null {
  switch (k) {
    case "ArrowLeft":
      return addDays(key, -1);
    case "ArrowRight":
      return addDays(key, 1);
    case "ArrowUp":
      return addDays(key, -7);
    case "ArrowDown":
      return addDays(key, 7);
    case "Home":
      return addDays(key, -weekday(key));
    case "End":
      return addDays(key, 6 - weekday(key));
    case "PageUp":
      return shift ? addMonths(key, -12) : addMonths(key, -1);
    case "PageDown":
      return shift ? addMonths(key, 12) : addMonths(key, 1);
    default:
      return null;
  }
}

/** A day picked in range mode, as react-day-picker's range: a first pick (or one after a full range) starts again; a second sets the other end. */
export function pickDay(range: { from: DayKey | null; to: DayKey | null }, day: DayKey): { from: DayKey; to: DayKey | null } {
  if (!range.from || range.to) return { from: day, to: null };
  return day < range.from ? { from: day, to: range.from } : { from: range.from, to: day };
}

/** A day as a screen reader hears it: `Thursday, November 19, 2026`. */
export function dayLabel(key: DayKey): string {
  const p = keyParts(key);
  return `${WEEKDAY_NAMES[weekday(key)]}, ${MONTHS[p.month]} ${p.day}, ${p.year}`;
}
