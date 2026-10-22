// One formatter per kind of value. Screens never call toFixed() or
// toLocaleString() directly: numbers look the same everywhere or they look
// generated.

const NBSP = "\u00a0";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 1,284 · 12.9K · 4.2M. Compact from 10,000 up so small counts stay exact. */
export function formatCount(n: number): string {
  return Math.abs(n) >= 10_000 ? compact.format(n) : integer.format(n);
}

/** Latency: "820 µs", "182 ms", "1.24 s", "2m 05s". Number and unit joined by a no-break space. */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}${NBSP}µs`;
  if (ms < 1000) return `${Math.round(ms)}${NBSP}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}${NBSP}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Rates: "0.42%", "12.5%", "100%". Never more than 2 decimals. */
export function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`.replace(/\.0+%$/, "%");
}

/** Signed delta vs a named period: "+12.4%", "−3.1%" (true minus sign). */
export function formatDelta(ratio: number): string {
  const sign = ratio > 0 ? "+" : ratio < 0 ? "−" : "±";
  return `${sign}${formatPercent(Math.abs(ratio))}`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${NBSP}${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

/** "12s ago", "5m ago", "yesterday". Pair with <time title={formatTimestamp(d)}>. */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const s = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

/** Absolute timestamp with explicit zone: "Oct 22, 14:05:09 UTC". */
export function formatTimestamp(date: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: "short",
  }).format(date);
  return parts.replace(/,(?=[^,]*$)/, "");
}
