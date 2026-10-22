// Formatting rules from the Aperture spec: tabular numbers, number and unit
// joined by a no-break space, em dash for missing values (rendered by callers).

const NBSP = " ";

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString("en-US");
  if (abs < 1_000_000) return `${trim((n / 1_000).toFixed(1))}k`;
  if (abs < 1_000_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
  return `${trim((n / 1_000_000_000).toFixed(1))}B`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms === 0) return `0${NBSP}ms`;
  if (ms < 10) return `${trim(ms.toFixed(1))}${NBSP}ms`;
  if (ms < 1_000) return `${Math.round(ms)}${NBSP}ms`;
  return `${trim((ms / 1_000).toFixed(2))}${NBSP}s`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  if (ratio === 0) return "0%";
  const pct = ratio * 100;
  if (pct < 0.1) return "<0.1%";
  if (pct >= 99.95 && pct < 100) return ">99.9%";
  if (pct >= 100) return "100%";
  return `${pct.toFixed(1)}%`;
}

export function formatRate(perMinute: number): string {
  if (perMinute === 0) return "none per minute";
  if (perMinute < 0.1) return "<0.1 per minute";
  return `${perMinute < 10 ? trim(perMinute.toFixed(1)) : formatCount(perMinute)} per minute`;
}

/** "just now", "45s ago", "12m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "2026-10-22 10:38:42 UTC" (times are rendered on the server, so UTC). */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** "10:38:42.125" in UTC, for log lines. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 23);
}

/** Axis label for a bucket start: "14:30" within a day, "Oct 22" for weeks. */
export function axisLabel(iso: string, bucketSeconds: number): string {
  const d = new Date(iso);
  if (bucketSeconds >= 3600) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return d.toISOString().slice(11, 16);
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
