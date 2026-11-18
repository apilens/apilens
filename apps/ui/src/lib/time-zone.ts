// The time zone the dashboard shows times in (#1046): the user's `preferences.timezone`, UTC when
// unset. Every formatter takes the zone as a parameter so the server and the browser render the
// same text. Pure; safe in Client and Server Components.

/** The zone used when the user has not picked one. */
export const DEFAULT_TIME_ZONE = "UTC";

const valid = new Map<string, boolean>();

/** Whether `tz` is an IANA zone this runtime can format in. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64) return false;
  let ok = valid.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    valid.set(tz, ok);
  }
  return ok;
}

/** The zone a user's preferences ask for, or {@link DEFAULT_TIME_ZONE}. */
export function resolveTimeZone(preferences: { timezone?: unknown } | null | undefined): string {
  const tz = preferences?.timezone;
  return isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached `Intl.DateTimeFormat` for `options` in `tz`. Formatters keep their options as a module
 * constant and call this per render, so a zone change never rebuilds more than one formatter.
 */
export function zoned(locale: string, options: Omit<Intl.DateTimeFormatOptions, "timeZone">, tz: string): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE });
    formats.set(key, f);
  }
  return f;
}

/** The wall-clock fields of an instant in `tz`, for code that used to read `getUTC*`. */
export interface ZonedParts {
  year: number;
  /** 0–11, like `Date.getUTCMonth`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const PARTS: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
};

export function zonedParts(at: number | Date, tz: string): ZonedParts {
  const t = typeof at === "number" ? at : at.getTime();
  const p: Record<string, number> = {};
  for (const { type, value } of zoned("en-US", PARTS, tz).formatToParts(t)) p[type] = Number(value);
  return {
    year: p.year,
    month: p.month - 1,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: ((t % 1000) + 1000) % 1000,
  };
}

/** Whether two instants fall on the same calendar day in `tz`. */
export function sameDay(a: number, b: number, tz: string): boolean {
  const x = zonedParts(a, tz);
  const y = zonedParts(b, tz);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** The offset of `tz` from UTC at `at`, in minutes (`Asia/Kolkata` → 330). */
export function zoneOffsetMinutes(tz: string, at: number = Date.now()): number {
  const p = zonedParts(at, tz);
  const wall = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second, p.millisecond);
  return Math.round((wall - at) / 60_000);
}

/** `GMT+5:30`, `GMT-4`, `GMT` for an offset in minutes. */
export function gmtOffset(minutes: number): string {
  if (minutes === 0) return "GMT";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

// English abbreviations Intl does not give in `en-US` (it answers `GMT+5:30` for these), kept to
// zones whose abbreviation is unambiguous and has no daylight saving.
const ABBREVIATIONS: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Singapore": "SGT",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Shanghai": "CST",
  "Asia/Jakarta": "WIB",
  "Asia/Dubai": "GST",
  "Asia/Karachi": "PKT",
  "Asia/Dhaka": "BST",
  "Asia/Manila": "PHT",
};

const SHORT_NAME: Omit<Intl.DateTimeFormatOptions, "timeZone"> = { timeZoneName: "short" };

/**
 * How labels name the zone: `UTC`, `IST`, `PST`/`PDT`, else `GMT+5:45`. Labels that used to end
 * in "UTC" end in this.
 */
export function zoneLabel(tz: string, at: number = Date.now()): string {
  if (tz === "UTC" || tz === "Etc/UTC" || tz === "Etc/GMT") return "UTC";
  const known = ABBREVIATIONS[tz];
  if (known) return known;
  const name = zoned("en-US", SHORT_NAME, tz)
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return name || gmtOffset(zoneOffsetMinutes(tz, at));
}

export interface TimeZoneOption {
  value: string;
  /** `Asia/Kolkata` → `Kolkata`; `America/Argentina/Buenos_Aires` → `Buenos Aires`. */
  city: string;
  /** `Asia`, `America/Argentina`; empty for UTC. */
  region: string;
  /** Offset now, in minutes. */
  offset: number;
  /** `GMT+5:30`. */
  gmt: string;
}

// ICU still lists some zones under their old names; show and save the current ones.
const CURRENT_NAME: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
};

/** `Asia/Calcutta` → `Asia/Kolkata`; other names unchanged. */
export const currentZoneName = (tz: string): string => CURRENT_NAME[tz] ?? tz;

let options: TimeZoneOption[] | null = null;

/** Every zone the runtime knows, with UTC first and the rest by offset then name. */
export function timeZoneOptions(now: number = Date.now()): TimeZoneOption[] {
  if (options) return options;
  const ids: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const list = [...new Set(ids.map(currentZoneName))]
    .filter((id) => id !== "UTC" && id.includes("/") && !id.startsWith("Etc/"))
    .map((value) => {
      const parts = value.split("/");
      const offset = zoneOffsetMinutes(value, now);
      return { value, city: parts[parts.length - 1].replace(/_/g, " "), region: parts.slice(0, -1).join("/"), offset, gmt: gmtOffset(offset) };
    })
    .sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value));
  options = [{ value: "UTC", city: "UTC", region: "", offset: 0, gmt: "GMT" }, ...list];
  return options;
}

/** The browser's own zone, or null outside a browser or when it is not one we can use. */
export function browserTimeZone(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const tz = currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone);
    return isTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/** Whether a zone option matches a search: city, region, zone id, abbreviation or `+5:30`. */
export function matchesZone(o: TimeZoneOption, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return true;
  const hay = `${o.value} ${o.city} ${o.region} ${o.gmt} ${zoneLabel(o.value)}`.toLowerCase().replace(/_/g, " ");
  return q.split(" ").every((w) => hay.includes(w));
}
