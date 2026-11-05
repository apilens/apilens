// The Explore request drawer (#588): one request's overview, headers, bodies, validation errors,
// trace waterfall and logs, from `GET /requests/{id}` (#577). Pure helpers (markers, header and body
// parsing, the collapsible JSON lines, cURL, the waterfall, the Route Handler's answer), unit-tested
// in request-detail.test.ts.
import type { RequestDetail, RequestDetailRead, TraceLog, TraceSpan } from "./identity";

/** The drawer's tabs, in order. */
export const DRAWER_TABS = [
  { slug: "overview", label: "Overview" },
  { slug: "headers", label: "Headers" },
  { slug: "request", label: "Request body" },
  { slug: "response", label: "Response body" },
  { slug: "validation", label: "Validation" },
  { slug: "trace", label: "Trace" },
  { slug: "logs", label: "Logs" },
] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number]["slug"];

/** The tab after `current` for a key (arrows wrap, Home and End jump), or null for other keys. */
export function moveTab(key: string, current: DrawerTab): DrawerTab | null {
  const i = DRAWER_TABS.findIndex((t) => t.slug === current);
  const n = DRAWER_TABS.length;
  switch (key) {
    case "ArrowRight":
      return DRAWER_TABS[(i + 1) % n].slug;
    case "ArrowLeft":
      return DRAWER_TABS[(i - 1 + n) % n].slug;
    case "Home":
      return DRAWER_TABS[0].slug;
    case "End":
      return DRAWER_TABS[n - 1].slug;
    default:
      return null;
  }
}

/** The Route Handler the drawer reads: `GET /api/projects/{slug}/requests/{id}`. */
export const requestDetailPath = (project: string, id: string) => `/api/projects/${encodeURIComponent(project)}/requests/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- markers

/** What the SDK put in place of a value: redacted (a matched name), masked (a whole body), truncated (the cap). */
export type Marker = "redacted" | "masked" | "truncated";
export interface Segment {
  text: string;
  marker?: Marker;
}

const MARKERS = /\[redacted\]|\[masked\]|(?:\.\.\.|…)\[truncated\]/g;

/** Splits `text` into plain runs and markers, so the markers can be styled apart from real values. */
export function markerSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKERS)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: m[0], marker: m[0] === "[redacted]" ? "redacted" : m[0] === "[masked]" ? "masked" : "truncated" });
    last = at + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ text: text.slice(last) });
  return out;
}

export const MARKER_TITLE: Record<Marker, string> = {
  redacted: "Redacted by the SDK before it left your app",
  masked: "The SDK masked the whole body before it left your app",
  truncated: "The SDK cut the body at its capture limit",
};

// ---------------------------------------------------------------- headers and bodies

/**
 * Stored headers (a JSON object text) as [name, value] pairs, in stored order. Array values join
 * with ", ". Empty text is null (not captured); text that is not an object is one pair named "".
 */
export function parseHeaders(text: string): [string, string][] | null {
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, Array.isArray(x) ? x.map(String).join(", ") : x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)]);
    }
  } catch {
    // Not JSON: shown as stored.
  }
  return [["", text]];
}

/** A body as the drawer shows it: nothing captured, a JSON value (tree), or text as stored. */
export type Body = { kind: "empty" } | { kind: "json"; value: unknown } | { kind: "text"; text: string };

/** Reads a stored body: JSON objects and arrays become a tree; anything else (a truncated JSON body too) stays text. */
export function parseBody(text: string): Body {
  if (!text) return { kind: "empty" };
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      // A body cut at the capture limit is not valid JSON any more.
    }
  }
  return { kind: "text", text };
}

// ---------------------------------------------------------------- JSON lines

/** One line of the JSON viewer. Containers are one line when collapsed, an open and a close line when expanded. */
export interface JsonLine {
  /** Position in the value, `""` for the root; the key of the expanded set. */
  path: string;
  depth: number;
  /** Object key or array index, absent for the root and close lines. */
  key?: string | number;
  kind: "open" | "close" | "collapsed" | "string" | "number" | "boolean" | "null";
  /** The printed value: `{`, `}`, `{…}`, `"text"`, `42`. Strings are printed with JSON escapes. */
  text: string;
  /** For strings, the raw value (marker detection reads it). */
  raw?: string;
  /** Children of a container (keys or items). */
  size?: number;
  comma: boolean;
}

const childPath = (path: string, key: string | number) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** The lines of `value` with the containers in `expanded` open. */
export function jsonLines(value: unknown, expanded: ReadonlySet<string>): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (v: unknown, path: string, depth: number, key: string | number | undefined, comma: boolean) => {
    if (v !== null && typeof v === "object") {
      const arr = Array.isArray(v);
      const entries: [string | number, unknown][] = arr ? (v as unknown[]).map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
      const [o, c] = arr ? ["[", "]"] : ["{", "}"];
      if (entries.length === 0) {
        out.push({ path, depth, key, kind: "collapsed", text: o + c, size: 0, comma });
        return;
      }
      if (!expanded.has(path)) {
        out.push({ path, depth, key, kind: "collapsed", text: `${o}…${c}`, size: entries.length, comma });
        return;
      }
      out.push({ path, depth, key, kind: "open", text: o, size: entries.length, comma: false });
      entries.forEach(([k, x], i) => walk(x, childPath(path, k), depth + 1, k, i < entries.length - 1));
      out.push({ path: `${path}#close`, depth, kind: "close", text: c, comma });
      return;
    }
    if (typeof v === "string") out.push({ path, depth, key, kind: "string", text: JSON.stringify(v), raw: v, comma });
    else if (typeof v === "number") out.push({ path, depth, key, kind: "number", text: String(v), comma });
    else if (typeof v === "boolean") out.push({ path, depth, key, kind: "boolean", text: String(v), comma });
    else out.push({ path, depth, key, kind: "null", text: "null", comma });
  };
  walk(value, "", 0, undefined, false);
  return out;
}

/**
 * The containers open at first: breadth first from the root while the shown lines stay within
 * `budget`, so a small body opens fully and a 64 KB one opens a level or two.
 */
export function defaultExpanded(value: unknown, budget = 400): Set<string> {
  const open = new Set<string>();
  let lines = 1;
  let level: [unknown, string][] = [[value, ""]];
  while (level.length) {
    const next: [unknown, string][] = [];
    for (const [v, path] of level) {
      if (v === null || typeof v !== "object") continue;
      const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) continue;
      // Opening adds a line per child and a close line.
      if (lines + entries.length + 1 > budget) return open;
      lines += entries.length + 1;
      open.add(path);
      for (const [k, x] of entries) next.push([x, childPath(path, k)]);
    }
    level = next;
  }
  return open;
}

/** Every container path of `value`, for Expand all. */
export function allContainers(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (v === null || typeof v !== "object") return;
    out.add(path);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, childPath(path, i)));
    else for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, childPath(path, k));
  };
  walk(value, "");
  return out;
}

/** `3 keys`, `1 item`: what a collapsed container holds. */
export function sizeLabel(line: Pick<JsonLine, "size" | "text">): string {
  const n = line.size ?? 0;
  const array = line.text.startsWith("[");
  return `${n} ${array ? (n === 1 ? "item" : "items") : n === 1 ? "key" : "keys"}`;
}

// ---------------------------------------------------------------- cURL

/** `value` quoted for a POSIX shell. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Headers cURL works out itself, left out of the command. */
const CURL_SKIP = new Set(["content-length", "host", "connection", "accept-encoding"]);

/**
 * The request as a cURL command, as stored: redacted values stay `[redacted]`, so the command never
 * carries a secret the SDK kept out. The URL is the base URL plus the URL as requested; without a
 * base URL it uses the Host header, else the path alone.
 */
export function curlCommand(r: Pick<RequestDetail, "method" | "raw_path" | "path" | "base_url" | "request_headers" | "request_body">): string {
  const headers = parseHeaders(r.request_headers) ?? [];
  const host = headers.find(([k]) => k.toLowerCase() === "host")?.[1];
  const base = r.base_url ? r.base_url.replace(/\/+$/, "") : host ? `https://${host}` : "";
  const lines = [`curl -X ${r.method.toUpperCase()} ${shellQuote(`${base}${r.raw_path || r.path}`)}`];
  for (const [k, v] of headers) {
    if (!k || CURL_SKIP.has(k.toLowerCase())) continue;
    lines.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (r.request_body) lines.push(`--data-raw ${shellQuote(r.request_body)}`);
  return lines.join(" \\\n  ");
}

// ---------------------------------------------------------------- trace

/** A span placed on the waterfall: its depth in the tree and its bar as percentages of the trace. */
export interface WaterfallRow {
  span: TraceSpan;
  depth: number;
  offset: number;
  width: number;
}

/**
 * The spans as a waterfall: parents before their children (siblings by start), each bar placed
 * against the whole trace (first start to last end). Spans whose parent is not in the trace are
 * roots. `total` is the trace's length in ms.
 */
export function waterfall(spans: readonly TraceSpan[]): { rows: WaterfallRow[]; total: number } {
  if (!spans.length) return { rows: [], total: 0 };
  const start = (s: TraceSpan) => Date.parse(s.start) || 0;
  const t0 = Math.min(...spans.map(start));
  const t1 = Math.max(...spans.map((s) => start(s) + Math.max(0, s.duration_ms)));
  const total = Math.max(t1 - t0, 0);
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const s of spans) {
    if (s.parent_span_id && s.parent_span_id !== s.span_id && ids.has(s.parent_span_id)) {
      children.set(s.parent_span_id, [...(children.get(s.parent_span_id) ?? []), s]);
    } else roots.push(s);
  }
  const byStart = (a: TraceSpan, b: TraceSpan) => start(a) - start(b);
  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const visit = (s: TraceSpan, depth: number) => {
    if (seen.has(s.span_id)) return;
    seen.add(s.span_id);
    const offset = total > 0 ? ((start(s) - t0) / total) * 100 : 0;
    const width = total > 0 ? (Math.max(0, s.duration_ms) / total) * 100 : 100;
    rows.push({ span: s, depth, offset, width: Math.min(width, 100 - offset) });
    for (const c of (children.get(s.span_id) ?? []).sort(byStart)) visit(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) visit(r, 0);
  // A cycle of parents has no root; show what is left flat rather than drop it.
  for (const s of spans) visit(s, 0);
  return { rows, total };
}

/** True when a span ended in error. */
export const spanFailed = (s: Pick<TraceSpan, "status" | "status_code">) => s.status.toLowerCase() === "error" || s.status_code >= 500;

/** How a log level reads: error and fatal error, warn warn, the rest neutral. */
export function levelTone(level: string): "error" | "warn" | "plain" {
  const l = level.toLowerCase();
  if (l.startsWith("err") || l === "fatal" || l === "critical") return "error";
  if (l.startsWith("warn")) return "warn";
  return "plain";
}

/** The span a log line belongs to, by name, else null. */
export function spanName(spans: readonly TraceSpan[], log: Pick<TraceLog, "span_id">): string | null {
  return spans.find((s) => s.span_id === log.span_id)?.name || null;
}

// ---------------------------------------------------------------- time

const CLOCK = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
  timeZone: "UTC",
});

/** An exact time: `Nov 5, 2026, 14:03:12.345 UTC`; empty for an unreadable one. */
export function formatExact(at: string): string {
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : `${CLOCK.format(t)} UTC`;
}

/** A log line's offset from the request: `+12.4 ms`, `-0.8 ms`. */
export function offsetMs(at: string, from: string): string {
  const d = Date.parse(at) - Date.parse(from);
  if (Number.isNaN(d)) return "";
  return `${d < 0 ? "−" : "+"}${Math.abs(d) < 10_000 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d)).toLocaleString("en-US")} ms`;
}

// ---------------------------------------------------------------- the read

/** The Route Handler's answer, as the drawer cares. */
export type DetailRead =
  | { kind: "detail"; data: RequestDetailRead }
  | { kind: "not_found" }
  | { kind: "expired"; next: string }
  | { kind: "error"; code: string };

/** Reads `{ok: true, detail}` or `{ok: false, code, next?}`. */
export function detailRead(status: number, body: unknown): DetailRead {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (b.ok === true && typeof b.detail === "object" && b.detail !== null) {
    const d = b.detail as Partial<RequestDetailRead>;
    if (d.request && typeof d.request === "object") return { kind: "detail", data: { request: d.request, spans: d.spans ?? [], logs: d.logs ?? [] } };
  }
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  if (status === 404 || code === "not_found") return { kind: "not_found" };
  return { kind: "error", code };
}

export const DETAIL_LOAD_FAILED = "We couldn’t load this request just now.";
export const DETAIL_NOT_FOUND = "This request is no longer stored. It may be older than the retention period.";
