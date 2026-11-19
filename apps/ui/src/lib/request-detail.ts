// The Explore request drawer (#588): one request's overview, headers, bodies, validation errors,
// trace waterfall and logs, from `GET /requests/{id}` (#577). Pure helpers (markers, header and body
// parsing, the collapsible JSON lines, cURL, the waterfall, the Route Handler's answer), unit-tested
// in request-detail.test.ts.
import type { RequestDetail, RequestDetailRead, TraceLog, TraceSpan } from "./identity";
import { zoneLabel, zonedParts } from "./time-zone";

/** The drawer's tabs, in order. */
export const DRAWER_TABS = [
  { slug: "request", label: "Request" },
  { slug: "response", label: "Response" },
  { slug: "timeline", label: "Timeline" },
  { slug: "consumer", label: "Consumer" },
  { slug: "raw", label: "Raw" },
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

/** A header value as text: arrays joined with ", ", objects as JSON. */
const headerValue = (x: unknown): string => (Array.isArray(x) ? x.map(headerValue).join(", ") : x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x));

/**
 * Stored headers as [name, value] pairs, in stored order: a JSON object (`{"accept": "*\/*"}`,
 * array values joined with ", "), a JSON list of pairs (`[["accept", "*\/*"]]`) or of
 * `{name, value}` objects, or raw `Name: value` lines (one header per line, as on the wire), so
 * no format shows as one run-on line. Empty text is null (not captured); text that is none of
 * these is one pair named "".
 */
export function parseHeaders(text: string): [string, string][] | null {
  if (!text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, headerValue(x)]);
    }
    if (Array.isArray(v)) {
      const pairs: [string, string][] = [];
      for (const item of v) {
        if (Array.isArray(item) && item.length >= 1 && typeof item[0] === "string") pairs.push([item[0], headerValue(item.length > 2 ? item.slice(1) : item[1])]);
        else if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") pairs.push([(item as { name: string }).name, headerValue((item as { value?: unknown }).value)]);
        else if (item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string") pairs.push([(item as { key: string }).key, headerValue((item as { value?: unknown }).value)]);
        else return [["", text]];
      }
      return pairs;
    }
  } catch {
    // Not JSON: header lines, or text shown as stored.
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const pairs = lines.map((l) => /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s?(.*)$/.exec(l));
  if (pairs.length && pairs.every((m) => m !== null)) return pairs.map((m) => [m?.[1] ?? "", (m?.[2] ?? "").trim()]);
  return [["", text]];
}

/** One server-sent event of a stored `text/event-stream` body. */
export interface StreamEvent {
  /** The `event:` name, `message` when the event names none. */
  event: string;
  /** The `data:` lines joined, parsed when they are JSON. */
  data: unknown;
  /** The data as stored. */
  text: string;
  /** The last event of a body cut at the capture limit: its data may be incomplete. */
  partial: boolean;
}

/**
 * A body as the drawer shows it: nothing captured, a JSON value (tree), form fields, a stream of
 * server-sent events, or text as stored.
 */
export type Body =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; fields: [string, string][] }
  | { kind: "events"; events: StreamEvent[] }
  | { kind: "text"; text: string };

/** The media type a stored headers text names (`content-type`), lower case without parameters; "" when none. */
export function contentTypeOf(headersText: string): string {
  const pair = parseHeaders(headersText)?.find(([k]) => k.toLowerCase() === "content-type");
  return pair ? pair[1].split(";")[0].trim().toLowerCase() : "";
}

/** A `text/event-stream` body as its events; a block with no `data:` line (a comment, a retry) is skipped. */
export function parseEventStream(text: string): StreamEvent[] {
  const blocks = text.replaceAll("\r\n", "\n").split("\n\n");
  // Complete bodies end with a blank line, so the split leaves an empty last block.
  const cut = blocks.at(-1)?.trim() !== "";
  const out: StreamEvent[] = [];
  blocks.forEach((block, i) => {
    let event = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === 0 || !line) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    const joined = data.join("\n");
    let parsed: unknown = joined;
    try {
      parsed = JSON.parse(joined);
    } catch {
      // Plain-text data, or JSON cut at the capture limit: shown as stored.
    }
    out.push({ event: event || "message", data: parsed, text: joined, partial: cut && i === blocks.length - 1 });
  });
  return out;
}

/** One run of consecutive events of the same name, as the stream view groups them (indices into the events). */
export interface StreamGroup {
  name: string;
  from: number;
  to: number;
}

/** A correlated value the stream carries (run, session, agent, model, tools), its distinct values in order. */
export interface StreamId {
  key: string;
  label: string;
  values: string[];
}

/** What a stream adds up to: its event types, its runs, the text it streamed and the ids it carries. */
export interface StreamSummary {
  types: { name: string; count: number }[];
  groups: StreamGroup[];
  /** The streamed text, joined from the content deltas; "" when the events carry none. */
  output: string;
  /** How many events added to `output`. */
  chunks: number;
  ids: StreamId[];
}

/** Fields that tie a stream's events to runs, sessions, agents and models (Agno, OpenAI, Anthropic shapes). */
const STREAM_IDS: [string, string][] = [
  ["run_id", "Run"],
  ["session_id", "Session"],
  ["agent_name", "Agent"],
  ["agent_id", "Agent ID"],
  ["team_name", "Team"],
  ["workflow_id", "Workflow"],
  ["user_id", "User"],
  ["model", "Model"],
  ["model_provider", "Provider"],
];
/** The most distinct values one id row lists. */
const STREAM_ID_MAX = 3;

const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The text one event adds to the streamed output, or null: `content` / `delta` / `text` of a
 * content or delta event (Agno RunContent, Anthropic content_block_delta), or OpenAI's
 * `choices[0].delta.content`. Completed events repeat the whole output, so they add nothing.
 */
export function eventDelta(e: Pick<StreamEvent, "event" | "data">): string | null {
  const d = record(e.data);
  if (!d) return null;
  const name = `${e.event} ${typeof d.event === "string" ? d.event : ""}`.toLowerCase();
  if (/complete|done|end|stop/.test(name)) return null;
  const choice = record(Array.isArray(d.choices) ? d.choices[0] : null);
  const openai = record(choice?.delta)?.content;
  if (typeof openai === "string") return openai;
  if (!/content|delta|chunk|token/.test(name)) return null;
  for (const v of [d.content, d.delta, d.text, record(d.delta)?.text]) if (typeof v === "string") return v;
  return null;
}

/** A stream's summary for the drawer (see StreamSummary). */
export function streamSummary(events: readonly StreamEvent[]): StreamSummary {
  const counts = new Map<string, number>();
  const groups: StreamGroup[] = [];
  const found = new Map<string, string[]>();
  const tools: string[] = [];
  let output = "";
  let chunks = 0;
  events.forEach((e, i) => {
    counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    const last = groups.at(-1);
    if (last && last.name === e.event) last.to = i;
    else groups.push({ name: e.event, from: i, to: i });
    const delta = eventDelta(e);
    if (delta !== null) {
      output += delta;
      chunks++;
    }
    const d = record(e.data);
    if (!d) return;
    for (const [key] of STREAM_IDS) {
      const v = d[key];
      if (typeof v !== "string" && typeof v !== "number") continue;
      const list = found.get(key) ?? [];
      if (!list.includes(String(v)) && list.length < STREAM_ID_MAX) list.push(String(v));
      found.set(key, list);
    }
    const tool = record(d.tool)?.tool_name ?? d.tool_name;
    if (typeof tool === "string" && !tools.includes(tool)) tools.push(tool);
  });
  const ids: StreamId[] = STREAM_IDS.filter(([k]) => found.get(k)?.length).map(([key, label]) => ({ key, label, values: found.get(key) ?? [] }));
  if (tools.length) ids.push({ key: "tools", label: "Tools", values: tools });
  return { types: [...counts].map(([name, count]) => ({ name, count })), groups, output, chunks, ids };
}

/**
 * Reads a stored body: JSON objects and arrays become a tree; a form body (by `contentType`) its
 * fields; an event stream its events; anything else (a truncated JSON body too) stays text.
 */
export function parseBody(text: string, contentType = ""): Body {
  if (!text) return { kind: "empty" };
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      // A body cut at the capture limit is not valid JSON any more.
    }
  }
  if (contentType === "application/x-www-form-urlencoded") {
    const fields = [...new URLSearchParams(text)];
    if (fields.length > 0) return { kind: "form", fields };
  }
  if (contentType === "text/event-stream") {
    const events = parseEventStream(text);
    if (events.length > 0) return { kind: "events", events };
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * An exact time in `tz`: `Nov 5, 2026, 14:03:12.345 UTC`; empty for an unreadable one. Built from
 * parts: engines join a formatted date and time differently (Node writes ", ", Safari and newer
 * ICU " at "), which broke hydration of the server-rendered drawer in Safari.
 */
export function formatExact(at: string, tz: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const p = zonedParts(t, tz);
  return `${MONTHS[p.month]} ${p.day}, ${p.year}, ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.millisecond, 3)} ${zoneLabel(tz, t)}`;
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
    if (d.request && typeof d.request === "object") return { kind: "detail", data: { request: d.request, spans: d.spans ?? [], logs: d.logs ?? [], trace_truncated: d.trace_truncated === true } };
  }
  const code = typeof b.code === "string" ? b.code : status >= 500 ? "unavailable" : "network_error";
  if (status === 401 && code === "session_expired") return { kind: "expired", next: typeof b.next === "string" ? b.next : "/sign-in" };
  if (status === 404 || code === "not_found") return { kind: "not_found" };
  return { kind: "error", code };
}

export const DETAIL_LOAD_FAILED = "We couldn’t load this request just now.";
export const DETAIL_NOT_FOUND = "This request is no longer stored. It may be older than the retention period.";
