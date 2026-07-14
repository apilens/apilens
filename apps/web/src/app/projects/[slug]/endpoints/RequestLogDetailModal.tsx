"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, Copy, Fingerprint, Globe, Info, Link2, Maximize2, Pause, Play, RotateCcw, Server, Terminal, Timer, TriangleAlert, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  formatBytes,
  formatDateTime,
  formatMs,
  highlightJson,
  parseHeaders,
  statusTone,
} from "./detail/sections";

/* ── Types ───────────────────────────────────────────────────────────── */

export interface RequestItem {
  timestamp: string;
  app_id: string;
  environment: string;
  method: string;
  path: string;
  // Exact request URL (/product/123). `path` is the endpoint template
  // (/product/{id}). Older rows have no raw_path — fall back to `path`.
  raw_path?: string;
  status_code: number;
  response_time_ms: number;
  request_size: number;
  response_size: number;
  ip_address: string;
  user_agent: string;
  consumer_id: string;
  consumer_name: string;
  consumer_group: string;
  trace_id?: string;
  span_id?: string;
}

// Payload/header detail, lazily fetched from endpoint-requests (the flat
// data/requests list doesn't carry bodies/headers).
interface PayloadRow {
  timestamp: string;
  method: string;
  status_code: number;
  request_payload?: string;
  response_payload?: string;
  request_headers?: string;
  response_headers?: string;
  base_url?: string;
  country?: string;
  country_code?: string;
  trace_id?: string;
  span_id?: string;
}

// A log line correlated with this request via trace_id (from /data/logs).
interface LogItem {
  timestamp: string;
  app_id: string;
  environment: string;
  level: string;
  message: string;
  logger_name: string;
  trace_id?: string;
  span_id?: string;
  payload: string;
  attributes: Record<string, string>;
}

// A span of the distributed trace this request belongs to (from /data/trace).
interface SpanItem {
  timestamp: string;
  app_id: string;
  environment: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  service_name: string;
  duration_ms: number;
  status: string;
  status_code: number;
  attributes: Record<string, string>;
}

type TabKey = "details" | "headers" | "response" | "trace" | "exceptions" | "related";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "details", label: "Details" },
  { key: "headers", label: "Headers" },
  { key: "response", label: "Payload" },
  { key: "trace", label: "Trace" },
  { key: "exceptions", label: "Exceptions" },
  { key: "related", label: "Related" },
];

function methodColor(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "#14b8a6";
  if (k === "POST") return "#5A9CF8";
  if (k === "PUT") return "#f59e0b";
  if (k === "PATCH") return "#a78bfa";
  if (k === "DELETE") return "#f87171";
  return "#94a3b8";
}
function timeShort(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function formatPayload(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function StatusText(code: number): string {
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return map[code] || "";
}

/* ── Sub-blocks ──────────────────────────────────────────────────────── */

function MetricCard({ label, icon, value }: { label: string; icon: React.ReactNode; value: string }) {
  return (
    <div className="ep-statcard">
      <div className="ep-statcard-label">{label}</div>
      <div className="ep-statcard-main">
        <span className="ep-statcard-icon">{icon}</span>
        <span className="ep-statcard-value">{value}</span>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ep-info-row">
      <span className="ep-info-key">{label}</span>
      <span className="ep-info-val">{value}</span>
    </div>
  );
}

function HeadersList({ raw, title }: { raw: string | undefined; title: string }) {
  const headers = parseHeaders(raw);
  if (headers.length === 0) {
    return (
      <div className="ep-rl-headblock">
        <h4 className="ep-rl-subhead">{title}</h4>
        <div className="endpoint-detail-empty">No headers captured.</div>
      </div>
    );
  }
  return (
    <div className="ep-rl-headblock">
      <h4 className="ep-rl-subhead">{title}</h4>
      <div className="ep-headers-list">
        {headers.map(([k, v]) => (
          <div key={k} className="ep-header-row">
            <span className="ep-header-key">{k}</span>
            <span className="ep-header-val">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Body({ title, raw }: { title: string; raw: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const body = formatPayload(raw);
  const isJson = !!body && body.length < 60_000 && (() => { try { JSON.parse(body); return true; } catch { return false; } })();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="ep-rl-bodyblock">
      <div className="ep-rl-bodyhead">
        <h4 className="ep-rl-subhead">{title}</h4>
        {body ? (
          <button type="button" className="ep-rl-copy" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      {body ? (
        isJson ? (
          <pre className="request-payload-pre" dangerouslySetInnerHTML={{ __html: highlightJson(body) }} />
        ) : (
          <pre className="request-payload-pre">{body}</pre>
        )
      ) : (
        <div className="endpoint-detail-empty">No body captured.</div>
      )}
    </div>
  );
}

/* ── Related tab ─────────────────────────────────────────────────────── */

const rowKey = (r: RequestItem) => `${r.timestamp}|${r.method}|${r.path}|${r.status_code}`;
// Exact URL for display/curl; `path` (template) still drives grouping/filters.
const reqUrl = (r: RequestItem) => r.raw_path || r.path;

function RelatedRow({
  r,
  current,
  onOpen,
  scrollRef,
}: {
  r: RequestItem;
  current: boolean;
  onOpen: (r: RequestItem) => void;
  scrollRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={scrollRef}
      className={`ep-rel-row${current ? " is-current" : ""}`}
      onClick={() => { if (!current) onOpen(r); }}
      aria-current={current ? "true" : undefined}
    >
      <span className="ep-rel-time">{timeShort(r.timestamp)}</span>
      <span className={`endpoint-status-pill ${statusTone(r.status_code)}`}>{r.status_code}</span>
      <span className="ep-rel-method" style={{ color: methodColor(r.method) }}>{r.method}</span>
      <span className="ep-rel-path">{reqUrl(r)}</span>
      {current && <span className="ep-rel-here">this request</span>}
      <span className="ep-rel-dur">{formatMs(r.response_time_ms)}</span>
    </button>
  );
}

function RelatedSection({
  title,
  rows,
  currentKey,
  onOpen,
  emptyMessage,
}: {
  title: string;
  rows: RequestItem[] | null;
  currentKey: string;
  onOpen: (r: RequestItem) => void;
  emptyMessage: string;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Centre the highlighted (current) request within the list — scroll only the
  // list, not the whole modal.
  useEffect(() => {
    const el = currentRef.current;
    const list = listRef.current;
    if (el && list) {
      list.scrollTop = Math.max(0, el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2);
    }
  }, [rows]);
  const count = rows ? rows.filter((r) => rowKey(r) !== currentKey).length : 0;
  return (
    <div className="ep-rl-headblock">
      <h4 className="ep-rl-subhead">
        {title}
        {count ? <span className="ep-rl-count">{count}</span> : null}
      </h4>
      {rows === null ? (
        <div className="endpoint-skeleton" style={{ height: 96 }} aria-hidden />
      ) : rows.length === 0 ? (
        <div className="endpoint-detail-empty">{emptyMessage}</div>
      ) : (
        <div className="ep-rel-list" ref={listRef}>
          {rows.map((r, i) => {
            const current = rowKey(r) === currentKey;
            return (
              <RelatedRow
                key={`${r.timestamp}-${i}`}
                r={r}
                current={current}
                onOpen={onOpen}
                scrollRef={current ? currentRef : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function RelatedTab({
  projectSlug,
  row,
  appSlugs,
  environment,
  since,
  until,
  onOpen,
}: {
  projectSlug: string;
  row: RequestItem;
  appSlugs: string[];
  environment?: string;
  since: string;
  until?: string;
  onOpen: (r: RequestItem) => void;
}) {
  const [sameEndpoint, setSameEndpoint] = useState<RequestItem[] | null>(null);
  const [sameConsumer, setSameConsumer] = useState<RequestItem[] | null>(null);
  const consumerKey = row.consumer_id || row.consumer_name || "";
  const currentKey = rowKey(row);

  // Keep the opened request in the list and show its chronological neighbours
  // (later requests above, earlier below — the list is newest-first).
  const windowAround = (items: RequestItem[]): RequestItem[] => {
    const list = items.slice();
    let ci = list.findIndex((r) => rowKey(r) === currentKey);
    if (ci < 0) {
      // The current request wasn't in the fetched window — inject it so it can
      // still be shown highlighted, placed by timestamp.
      list.push(row);
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      ci = list.findIndex((r) => rowKey(r) === currentKey);
    }
    const start = Math.max(0, ci - 10);
    return list.slice(start, ci + 11);
  };

  useEffect(() => {
    let cancelled = false;
    const base = () => {
      const p = new URLSearchParams();
      p.set("since", since);
      if (until) p.set("until", until);
      if (environment) p.set("environment", environment);
      if (appSlugs.length) p.set("app_slugs", appSlugs.join(","));
      return p;
    };
    // Same endpoint (server-filtered by method + exact path).
    (async () => {
      const p = base();
      p.set("methods", row.method);
      p.set("path_filter", row.path);
      p.set("page_size", "200");
      try {
        const res = await fetch(`/api/projects/${projectSlug}/data/requests?${p.toString()}`);
        const data = res.ok ? await res.json() : { items: [] };
        if (cancelled) return;
        setSameEndpoint(windowAround(data.items || []));
      } catch { if (!cancelled) setSameEndpoint([]); }
    })();
    // Same consumer (no server-side consumer filter — match client-side over a
    // wider recent window).
    (async () => {
      if (!consumerKey) { setSameConsumer([]); return; }
      const p = base();
      p.set("page_size", "200");
      try {
        const res = await fetch(`/api/projects/${projectSlug}/data/requests?${p.toString()}`);
        const data = res.ok ? await res.json() : { items: [] };
        if (cancelled) return;
        const matches = (data.items || []).filter(
          (r: RequestItem) => (r.consumer_id || r.consumer_name) === consumerKey,
        );
        setSameConsumer(windowAround(matches));
      } catch { if (!cancelled) setSameConsumer([]); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, row, appSlugs, environment, since, until, consumerKey]);

  return (
    <>
      <RelatedSection
        title="Same endpoint"
        rows={sameEndpoint}
        currentKey={currentKey}
        onOpen={onOpen}
        emptyMessage="No other requests to this endpoint in this period."
      />
      <RelatedSection
        title={consumerKey ? `From this consumer (${consumerKey})` : "From this consumer"}
        rows={sameConsumer}
        currentKey={currentKey}
        onOpen={onOpen}
        emptyMessage={consumerKey ? "No other requests from this consumer in this period." : "This request has no identified consumer."}
      />
    </>
  );
}

/* ── Trace tab ───────────────────────────────────────────────────────── */

function levelTone(level: string): string {
  const l = (level || "").toUpperCase();
  if (l === "ERROR" || l === "CRITICAL") return "endpoint-status-5xx";
  if (l === "WARNING") return "endpoint-status-4xx";
  if (l === "DEBUG") return "endpoint-status-3xx";
  return "endpoint-status-2xx";
}

function spanColor(kind: string, status: string): string {
  if (status === "error") return "#f87171";
  const k = (kind || "").toLowerCase();
  if (k === "server") return "#14b8a6";
  if (k === "http" || k === "client") return "#5A9CF8";
  if (k === "db") return "#f59e0b";
  return "#94a3b8";
}

// Depth of each span in the tree (root = 0); tolerates missing parents
// (e.g. the caller's span in another project) and cycles.
function spanDepths(spans: SpanItem[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const depths = new Map<string, number>();
  for (const s of spans) {
    let depth = 0;
    let cur: SpanItem | undefined = s;
    const seen = new Set<string>();
    while (cur && cur.parent_span_id && byId.has(cur.parent_span_id) && !seen.has(cur.span_id) && depth < 8) {
      seen.add(cur.span_id);
      cur = byId.get(cur.parent_span_id);
      depth += 1;
    }
    depths.set(s.span_id, depth);
  }
  return depths;
}

/* ── Request flow map ────────────────────────────────────────────────── */
//
// Collapses the span tree into a service-to-service flow graph: one node per
// service (from its server spans), one edge per caller→callee hop (timed by
// the caller's client span). Reads as "where the request entered, which
// services it touched, how long each hop took, and where the failure
// originated" — the narrative the raw waterfall makes you assemble yourself.

interface FlowNode {
  key: string;
  service: string;
  op: string; // first operation handled in this service (labels the node)
  durMs: number;
  failed: boolean;
  depth: number;
  entry: boolean;
  origin: boolean; // deepest failing node — where the failure started
  startMs: number; // when this service first became active, relative to trace start
  endMs: number;
}

interface FlowEdge {
  from: string;
  to: string;
  durMs: number;
  calls: number;
  failed: boolean;
  startMs: number; // when the (first) call over this hop started, relative to trace start
  endMs: number;
}

function buildFlow(spans: SpanItem[]): { nodes: FlowNode[]; edges: FlowEdge[] } | null {
  if (spans.length < 2) return null;
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const kindOf = (s: SpanItem) => (s.kind || "").toLowerCase();
  const svcOf = (s: SpanItem) => s.service_name || s.name;
  const servers = [...spans]
    .filter((s) => kindOf(s) === "server")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (!servers.length) return null;

  const traceStart = Math.min(...spans.map((s) => new Date(s.timestamp).getTime()));
  const relStart = (s: SpanItem) => new Date(s.timestamp).getTime() - traceStart;
  const relEnd = (s: SpanItem) => relStart(s) + Math.max(s.duration_ms, 0);

  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const ensureNode = (key: string, service: string, op: string): FlowNode => {
    let n = nodes.get(key);
    if (!n) {
      n = {
        key, service, op, durMs: 0, failed: false, depth: 0, entry: false, origin: false,
        startMs: Number.POSITIVE_INFINITY, endMs: 0,
      };
      nodes.set(key, n);
    }
    return n;
  };
  const addEdge = (from: string, to: string, timing: SpanItem, failed: boolean) => {
    const key = `${from}→${to}`;
    const e = edges.get(key) || { from, to, durMs: 0, calls: 0, failed: false, startMs: Number.POSITIVE_INFINITY, endMs: 0 };
    e.durMs += Math.max(timing.duration_ms, 0);
    e.calls += 1;
    e.failed = e.failed || failed;
    e.startMs = Math.min(e.startMs, relStart(timing));
    e.endMs = Math.max(e.endMs, relEnd(timing));
    edges.set(key, e);
  };
  // Walk from a span up to its nearest ancestor *server* span, remembering
  // the client/http span crossed on the way (it times the hop).
  const nearestAncestorServer = (s: SpanItem): { server: SpanItem | null; via: SpanItem | null } => {
    const seen = new Set<string>([s.span_id]);
    let via: SpanItem | null = null;
    let cur = s.parent_span_id ? byId.get(s.parent_span_id) : undefined;
    while (cur && !seen.has(cur.span_id)) {
      seen.add(cur.span_id);
      if (kindOf(cur) === "server") return { server: cur, via };
      if (!via && (kindOf(cur) === "client" || kindOf(cur) === "http")) via = cur;
      cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
    }
    return { server: null, via };
  };

  for (const s of servers) {
    const n = ensureNode(svcOf(s), svcOf(s), s.name);
    n.durMs += Math.max(s.duration_ms, 0);
    n.failed = n.failed || s.status === "error";
    n.startMs = Math.min(n.startMs, relStart(s));
    n.endMs = Math.max(n.endMs, relEnd(s));
    const { server: parent, via } = nearestAncestorServer(s);
    if (parent && svcOf(parent) !== svcOf(s)) {
      addEdge(svcOf(parent), svcOf(s), via ?? s, s.status === "error" || via?.status === "error");
    }
  }

  // Client calls with no server span beneath them left the system (external
  // API, or a callee that isn't instrumented) — surface them as leaf nodes.
  const children = new Map<string, SpanItem[]>();
  for (const s of spans) {
    if (s.parent_span_id) children.set(s.parent_span_id, [...(children.get(s.parent_span_id) || []), s]);
  }
  const hasServerBeneath = (id: string, depth = 0): boolean =>
    depth < 8 && (children.get(id) || []).some((c) => kindOf(c) === "server" || hasServerBeneath(c.span_id, depth + 1));
  for (const c of spans) {
    if (kindOf(c) !== "client" && kindOf(c) !== "http") continue;
    if (hasServerBeneath(c.span_id)) continue;
    const { server: parent } = nearestAncestorServer(c);
    if (!parent) continue;
    const key = `ext:${c.name}`;
    const n = ensureNode(key, c.name, "not instrumented");
    n.durMs += Math.max(c.duration_ms, 0);
    n.failed = n.failed || c.status === "error";
    n.startMs = Math.min(n.startMs, relStart(c));
    n.endMs = Math.max(n.endMs, relEnd(c));
    addEdge(svcOf(parent), key, c, c.status === "error");
  }

  // A map with no hops adds nothing over the waterfall.
  if (!edges.size) return null;

  // Hop depth via BFS from the entry nodes (never the target of an edge).
  const targets = new Set([...edges.values()].map((e) => e.to));
  const out = new Map<string, string[]>();
  for (const e of edges.values()) out.set(e.from, [...(out.get(e.from) || []), e.to]);
  const queue: string[] = [];
  for (const n of nodes.values()) {
    if (!targets.has(n.key)) { n.entry = true; n.depth = 0; queue.push(n.key); }
  }
  const visited = new Set(queue);
  while (queue.length) {
    const k = queue.shift()!;
    const d = nodes.get(k)!.depth;
    for (const t of out.get(k) || []) {
      if (visited.has(t)) continue;
      visited.add(t);
      const tn = nodes.get(t)!;
      tn.depth = d + 1;
      queue.push(t);
    }
  }
  const failing = [...nodes.values()].filter((n) => n.failed);
  if (failing.length) failing.sort((a, b) => b.depth - a.depth)[0].origin = true;

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// Wall-clock time (ms) a full replay takes at 1× — real traces finish in
// milliseconds, so the animation stretches them to a watchable pace.
const REPLAY_WALL_MS = 4000;
const REPLAY_SPEEDS = [0.5, 1, 2];

// Point at parameter u along the same cubic bezier the edge path uses
// (P0→(mid,y1)→(mid,y2)→P3) — drives the traveling pulse during replay.
function bezierPoint(x1: number, y1: number, x2: number, y2: number, u: number) {
  const mx = (x1 + x2) / 2;
  const w = 1 - u;
  return {
    x: w * w * w * x1 + 3 * w * w * u * mx + 3 * w * u * u * mx + u * u * u * x2,
    y: w * w * w * y1 + 3 * w * w * u * y1 + 3 * w * u * u * y2 + u * u * u * y2,
  };
}

function FlowMap({ spans, onReplayTime }: { spans: SpanItem[]; onReplayTime?: (t: number | null) => void }) {
  const flow = useMemo(() => buildFlow(spans), [spans]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [lines, setLines] = useState<Array<{ x1: number; y1: number; x2: number; y2: number; edge: FlowEdge }>>([]);

  // Pan/zoom — the stage is translated/scaled inside a clipping viewport, so
  // any number of services stays navigable (drag to pan, wheel to zoom).
  const [view, setView] = useState({ x: 24, y: 60, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Replay clock: null → the finished/static picture; otherwise the trace
  // time (ms since the request entered) currently being shown.
  const T = useMemo(
    () => (flow ? Math.max(1, ...flow.nodes.map((n) => n.endMs), ...flow.edges.map((e) => e.endMs)) : 1),
    [flow],
  );
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  // Mirror the replay clock up to the trace tab so the span waterfall can
  // highlight whichever spans are active at this moment of the replay.
  useEffect(() => { onReplayTime?.(t); }, [t, onReplayTime]);
  useEffect(() => () => { onReplayTime?.(null); }, [onReplayTime]);

  const recompute = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !flow) return;
    // Rects are scaled by the current zoom — divide it back out so line
    // coordinates live in the stage's own (untransformed) space.
    const k = viewRef.current.k || 1;
    const sr = stage.getBoundingClientRect();
    setLines(
      flow.edges.flatMap((edge) => {
        const a = nodeRefs.current.get(edge.from);
        const b = nodeRefs.current.get(edge.to);
        if (!a || !b) return [];
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return [{
          x1: (ra.right - sr.left) / k,
          y1: (ra.top + ra.height / 2 - sr.top) / k,
          x2: (rb.left - sr.left) / k,
          y2: (rb.top + rb.height / 2 - sr.top) / k,
          edge,
        }];
      }),
    );
  }, [flow]);

  const fitView = useCallback(() => {
    const vp = viewportRef.current;
    const stage = stageRef.current;
    if (!vp || !stage) return;
    const iw = stage.offsetWidth;
    const ih = stage.offsetHeight;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (!iw || !ih || !vw || !vh) return;
    const k = Math.max(0.25, Math.min(1.15, (vw - 48) / iw, (vh - 104) / ih));
    setView({ k, x: (vw - iw * k) / 2, y: Math.max(56, (vh - ih * k) / 2 + 18) });
  }, []);

  const didFit = useRef(false);
  useLayoutEffect(() => { didFit.current = false; }, [flow]);
  useLayoutEffect(() => {
    recompute();
    if (!didFit.current) { didFit.current = true; fitView(); }
  }, [recompute, fitView]);
  useEffect(() => {
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [recompute]);

  // Wheel zoom toward the cursor. Attached manually: React's onWheel is
  // passive, and we must preventDefault or the page scrolls instead.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const nk = Math.min(2.5, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0015)));
        const r = nk / v.k;
        return { k: nk, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
      });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  // Replay clock — advances trace-time so a request that took 23ms plays
  // back over ~4s (÷ speed).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const speed = REPLAY_SPEEDS[speedIdx];
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setT((prev) => {
        const next = (prev ?? 0) + (dt / (REPLAY_WALL_MS / speed)) * T;
        // Finished: drop back to the idle/static picture (null) so padded
        // sub-ms windows can't stay lit past the end of the replay.
        if (next >= T) { setPlaying(false); return null; }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speedIdx, T]);

  if (!flow) return null;

  const maxDepth = Math.max(...flow.nodes.map((n) => n.depth));
  const cols: FlowNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of flow.nodes) cols[n.depth].push(n);

  // Zero-length windows (sub-ms spans) get a minimum visible width so the
  // replay never skips a hop.
  const pad = T * 0.03;
  const phase = (startMs: number, endMs: number): "pending" | "active" | "done" => {
    if (t === null) return "done";
    const end = Math.max(endMs, startMs + pad);
    if (t < startMs) return "pending";
    if (t < end) return "active";
    return "done";
  };

  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    setT((cur) => (cur === null || cur >= T ? 0 : cur));
    setPlaying(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".ep-flow-ctl")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, x: viewRef.current.x, y: viewRef.current.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
  };
  const endDrag = () => { dragRef.current = null; };

  return (
    <>
      <h4 className="ep-rl-subhead">Request flow</h4>
      <div
        className={`ep-flow-canvas${dragRef.current ? " is-panning" : ""}`}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="ep-flow-ctl ep-flow-replaybar">
          <button type="button" className="ep-flow-btn" onClick={togglePlay} title={playing ? "Pause replay" : "Replay this request"}>
            {playing ? <Pause size={12} /> : t !== null && t < T ? <Play size={12} /> : <RotateCcw size={12} />}
            {playing ? "Pause" : t !== null && t < T ? "Resume" : "Replay"}
          </button>
          <input
            type="range"
            className="ep-flow-scrub"
            min={0}
            max={1000}
            value={Math.round(((t ?? T) / T) * 1000)}
            onChange={(e) => { setPlaying(false); setT((Number(e.target.value) / 1000) * T); }}
            aria-label="Replay position"
          />
          <span className="ep-flow-time">{formatMs(Math.min(t ?? T, T))} / {formatMs(T)}</span>
          <button
            type="button"
            className="ep-flow-btn"
            onClick={() => setSpeedIdx((i) => (i + 1) % REPLAY_SPEEDS.length)}
            title="Replay speed"
          >
            {REPLAY_SPEEDS[speedIdx]}×
          </button>
        </div>
        <div className="ep-flow-ctl ep-flow-zoomctl">
          <button type="button" className="ep-flow-btn" onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.25) }))} title="Zoom out"><ZoomOut size={12} /></button>
          <button type="button" className="ep-flow-btn" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.25) }))} title="Zoom in"><ZoomIn size={12} /></button>
          <button type="button" className="ep-flow-btn" onClick={fitView} title="Fit to view"><Maximize2 size={12} /></button>
        </div>
        <div
          className="ep-flow-stage"
          ref={stageRef}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg className="ep-flow-svg" aria-hidden>
            <defs>
              <marker id="ep-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="#64748b" />
              </marker>
              <marker id="ep-flow-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="#f87171" />
              </marker>
              <marker id="ep-flow-arrow-live" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="#14b8a6" />
              </marker>
            </defs>
            {lines.map(({ x1, y1, x2, y2, edge }) => {
              const midX = (x1 + x2) / 2;
              const ph = phase(edge.startMs, edge.endMs);
              const end = Math.max(edge.endMs, edge.startMs + pad);
              const u = ph === "active" && t !== null ? Math.min(1, Math.max(0, (t - edge.startMs) / (end - edge.startMs))) : 0;
              const dot = ph === "active" ? bezierPoint(x1, y1, x2 - 2, y2, u) : null;
              const stroke = ph === "pending" ? "#64748b" : ph === "active" ? (edge.failed ? "#f87171" : "#14b8a6") : edge.failed ? "#f87171" : "#64748b";
              const marker = ph === "active" ? (edge.failed ? "ep-flow-arrow-bad" : "ep-flow-arrow-live") : edge.failed ? "ep-flow-arrow-bad" : "ep-flow-arrow";
              return (
                <g key={`${edge.from}-${edge.to}`} opacity={ph === "pending" ? 0.25 : 1}>
                  <path
                    d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2 - 2} ${y2}`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={ph === "active" ? 2 : 1.4}
                    markerEnd={`url(#${marker})`}
                  />
                  {dot ? <circle cx={dot.x} cy={dot.y} r={4} fill={edge.failed ? "#f87171" : "#14b8a6"} className="ep-flow-pulse" /> : null}
                  <text x={midX} y={(y1 + y2) / 2 - 7} textAnchor="middle" className="ep-flow-edge-label" fill={edge.failed && ph !== "pending" ? "#f87171" : "var(--text-muted)"}>
                    {edge.calls > 1 ? `×${edge.calls} · ` : ""}{formatMs(edge.durMs)}{edge.failed ? " · failed" : ""}
                  </text>
                </g>
              );
            })}
          </svg>
          {cols.map((col, ci) => (
            <div key={ci} className="ep-flow-col">
              {col.map((n) => {
                const ph = phase(n.startMs, n.endMs);
                return (
                  <div
                    key={n.key}
                    ref={(el) => { if (el) nodeRefs.current.set(n.key, el); else nodeRefs.current.delete(n.key); }}
                    className={`ep-flow-node is-${ph}${n.failed ? " is-failed" : ""}`}
                  >
                    <div className="ep-flow-node-svc">
                      {n.service}
                      {n.entry ? <span className="ep-flow-tag">entry</span> : null}
                      {n.origin ? <span className="ep-flow-tag is-origin">failure origin</span> : null}
                    </div>
                    <div className="ep-flow-node-op" title={n.op}>{n.op}</div>
                    <div className="ep-flow-node-meta">{formatMs(n.durMs)}{n.failed && !n.origin ? " · impacted" : ""}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Waterfall({
  spans,
  excIndicesBySpan,
  onOpenExceptions,
  replayT,
}: {
  spans: SpanItem[];
  excIndicesBySpan: Map<string, number[]>;
  onOpenExceptions: (indices: number[]) => void;
  // Flow-map replay clock (ms since trace start); null when idle. Spans
  // active at this instant highlight; ones not yet reached dim; once the
  // replay passes a span (or ends) it returns to its normal look.
  replayT?: number | null;
}) {
  const depths = spanDepths(spans);
  const starts = spans.map((s) => new Date(s.timestamp).getTime());
  const traceStart = Math.min(...starts);
  const traceEnd = Math.max(...spans.map((s, i) => starts[i] + Math.max(s.duration_ms, 0)));
  const total = Math.max(traceEnd - traceStart, 1);

  return (
    <div className="ep-trace">
      <div className="ep-trace-axis" aria-hidden>
        <span className="ep-trace-axis-name">
          Span
          {/* The how-to-read-this explainer lives behind a hover icon so the
              waterfall itself stays clean. */}
          <span
            className="ep-trace-info"
            title={`Each row is one step of this request. A bar's position shows when the step started and its length shows how long it took, across the request's total of ${formatMs(total)}.`}
          >
            <Info size={12} />
          </span>
        </span>
        <span className="ep-trace-axis-scale">
          <span>0</span>
          <span>{formatMs(total / 2)}</span>
          <span>{formatMs(total)}</span>
        </span>
        <span className="ep-trace-axis-dur">Duration</span>
      </div>
      <div className="ep-rel-list">
        {spans.map((s, i) => {
          const startOffset = starts[i] - traceStart;
          const left = Math.min((startOffset / total) * 100, 99);
          const width = Math.max(Math.min((Math.max(s.duration_ms, 0) / total) * 100, 100 - left), 0.75);
          const color = spanColor(s.kind, s.status);
          // Exceptions correlated to this span (raised in it or anywhere
          // beneath it in the trace tree — see excIndicesBySpan).
          const spanExcIndices = excIndicesBySpan.get(s.span_id) || [];
          const hasException = spanExcIndices.length > 0 || s.status === "error";
          // Replay phase of this row (pad sub-ms spans so they visibly light up).
          const relStart = startOffset;
          const relEnd = Math.max(relStart + Math.max(s.duration_ms, 0), relStart + total * 0.03);
          const replayClass =
            replayT === null || replayT === undefined
              ? ""
              : replayT < relStart
                ? " is-replay-pending"
                : replayT < relEnd
                  ? ` is-replay-active${s.status === "error" ? " is-failed" : ""}`
                  : "";
          return (
            <div key={`${s.span_id}-${i}`} className={`ep-trace-item${replayClass}`}>
              <div className="ep-trace-row">
                <span
                  className="ep-trace-name"
                  style={{ paddingLeft: (depths.get(s.span_id) || 0) * 14 }}
                  title={`${s.name}${s.service_name ? ` · ${s.service_name}` : ""}`}
                >
                  <span className="ep-trace-kind" style={{ color }}>{s.kind || "internal"}</span>
                  {s.name}
                  {hasException ? (
                    <button
                      type="button"
                      className="ep-trace-exc"
                      title="This step failed — open its exception"
                      onClick={() => onOpenExceptions(spanExcIndices)}
                    >
                      <TriangleAlert size={10} /> exception
                    </button>
                  ) : null}
                </span>
                <span
                  className="ep-trace-track"
                  title={`Started +${formatMs(startOffset)} into the request · ran for ${formatMs(s.duration_ms)}`}
                >
                  <span className="ep-trace-bar" style={{ left: `${left}%`, width: `${width}%`, background: color }} />
                </span>
                <span className="ep-rel-dur">{formatMs(s.duration_ms)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The raw text of an exception log: the full traceback when APILens captured
// one (`apilens.exception` errors), otherwise the full untruncated message.
function rawException(log: LogItem): string {
  return log.payload && log.payload.trim() ? log.payload : log.message;
}

// One log line. Always expandable — shows the raw exception verbatim.
function LogRow({ log, defaultOpen = false, scrollTo = false }: { log: LogItem; defaultOpen?: boolean; scrollTo?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Bring the focused exception into view when opened via a span badge.
  useEffect(() => {
    if (scrollTo) rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollTo]);
  const hasPayload = !!(log.payload && log.payload.trim());
  const level = (log.level || "INFO").toUpperCase();
  const isError = level === "ERROR" || level === "CRITICAL";
  const copyTrace = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(rawException(log));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div ref={rootRef} className={`ep-log-item${open ? " is-open" : ""}${isError ? " is-error" : ""}`}>
      <button
        type="button"
        className="ep-log-row is-expandable"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight size={13} className={`ep-log-caret${open ? " is-open" : ""}`} />
        <span className="ep-rel-time">{timeShort(log.timestamp)}</span>
        <span className={`endpoint-status-pill ${levelTone(log.level)}`}>{level}</span>
        {log.logger_name ? <span className="ep-log-logger" title={log.logger_name}>{log.logger_name}</span> : null}
        <span className="ep-log-msg" title={log.message}>{log.message}</span>
        <span className="ep-log-toggle">{open ? "Hide" : hasPayload ? "Stack trace" : "Details"}</span>
      </button>
      {open ? (
        <div className="ep-log-trace-wrap">
          <div className="ep-log-trace-head">
            <span>{hasPayload ? "Traceback" : "Raw message"}</span>
            <button type="button" className="ep-rl-copy" onClick={copyTrace}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="request-payload-pre ep-log-trace">{rawException(log)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function TraceTab({
  projectSlug,
  traceId,
  loadingTrace,
  exceptionLogs,
  onOpenExceptions,
}: {
  projectSlug: string;
  traceId: string;
  loadingTrace: boolean;
  exceptionLogs: LogItem[] | null;
  onOpenExceptions: (indices: number[]) => void;
}) {
  const [spans, setSpans] = useState<SpanItem[] | null>(null);
  // Flow-map replay clock, mirrored here so the waterfall highlights along.
  const [replayT, setReplayT] = useState<number | null>(null);
  // Correlate each exception (by its index in exceptionLogs — the same array
  // the Exceptions tab renders) to a span. A span's badge opens the
  // exception raised IN that span when it has one; a span with no direct
  // exception (e.g. the caller's client span of a cross-service failure —
  // the log is tied to the callee's server span) falls back to the failures
  // raised anywhere beneath it. Preferring the direct match keeps the root
  // span from opening the whole trace's exceptions at once.
  const excIndicesBySpan = new Map<string, number[]>();
  if (spans && exceptionLogs) {
    const byId = new Map(spans.map((s) => [s.span_id, s]));
    const direct = new Map<string, number[]>();
    const subtree = new Map<string, number[]>();
    exceptionLogs.forEach((l, i) => {
      const sid = (l.span_id || "").trim();
      if (!sid) return;
      direct.set(sid, [...(direct.get(sid) || []), i]);
      const seen = new Set<string>();
      let cur: SpanItem | undefined = byId.get(sid);
      while (cur && !seen.has(cur.span_id)) {
        seen.add(cur.span_id);
        subtree.set(cur.span_id, [...(subtree.get(cur.span_id) || []), i]);
        cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
      }
    });
    for (const s of spans) {
      const own = direct.get(s.span_id) || [];
      const sub = subtree.get(s.span_id) || [];
      if (own.length) excIndicesBySpan.set(s.span_id, own);
      else if (sub.length) excIndicesBySpan.set(s.span_id, sub);
    }
  }

  useEffect(() => {
    if (!traceId) { setSpans(null); return; }
    let cancelled = false;
    setSpans(null);
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/data/trace?trace_id=${encodeURIComponent(traceId)}`);
        const data = res.ok ? await res.json() : { spans: [] };
        if (!cancelled) setSpans(data.spans || []);
      } catch { if (!cancelled) setSpans([]); }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, traceId]);

  if (!traceId) {
    return loadingTrace ? (
      <div className="endpoint-skeleton" style={{ height: 96 }} aria-hidden />
    ) : (
      <div className="endpoint-detail-empty">
        No trace id was captured for this request, so its trace can&apos;t be shown.
        Requests recorded before trace support don&apos;t carry one — upgrade the APILens SDK to enable it.
      </div>
    );
  }

  return (
    <div className="ep-rl-headblock">
      {spans && spans.length > 0 ? <FlowMap spans={spans} onReplayTime={setReplayT} /> : null}
      <h4 className="ep-rl-subhead">
        Spans
        {spans?.length ? <span className="ep-rl-count">{spans.length}</span> : null}
      </h4>
      {spans === null ? (
        <div className="endpoint-skeleton" style={{ height: 96 }} aria-hidden />
      ) : spans.length === 0 ? (
        <div className="endpoint-detail-empty">
          No spans recorded for this trace yet. Spans are captured automatically — upgrade the APILens SDK
          if this request is missing them.
        </div>
      ) : (
        <Waterfall spans={spans} excIndicesBySpan={excIndicesBySpan} onOpenExceptions={onOpenExceptions} replayT={replayT} />
      )}
    </div>
  );
}

/* ── Exceptions tab ──────────────────────────────────────────────────── */

function ExceptionsTab({
  logs,
  traceId,
  loadingTrace,
  focus,
}: {
  logs: LogItem[] | null;
  traceId: string;
  loadingTrace: boolean;
  // Set when a span's exception badge was clicked in the Trace tab: exactly
  // these accordions open (and the first scrolls into view) instead of the
  // default first-one-open. `token` changes per click so re-clicking the same
  // badge re-applies the focus.
  focus?: { indices: number[]; token: number } | null;
}) {
  if (!traceId) {
    return loadingTrace ? (
      <div className="endpoint-skeleton" style={{ height: 96 }} aria-hidden />
    ) : (
      <div className="endpoint-detail-empty">
        No trace id was captured for this request, so exceptions can&apos;t be shown.
        Requests recorded before trace support don&apos;t carry one — upgrade the APILens SDK to enable it.
      </div>
    );
  }
  return (
    <div className="ep-rl-headblock">
      <h4 className="ep-rl-subhead">
        Exceptions
        {logs?.length ? <span className="ep-rl-count">{logs.length}</span> : null}
      </h4>
      {logs === null ? (
        <div className="endpoint-skeleton" style={{ height: 96 }} aria-hidden />
      ) : logs.length === 0 ? (
        <div className="endpoint-detail-empty">
          No exceptions on this request. APILens records one here automatically when a request raises an
          exception or returns a 5xx — a clean request has nothing to show.
        </div>
      ) : (
        <div className="ep-rel-list ep-exc-list">
          {logs.map((l, i) => (
            <LogRow
              key={`${focus?.token ?? "d"}-${l.timestamp}-${i}`}
              log={l}
              defaultOpen={focus ? focus.indices.includes(i) : i === 0}
              scrollTo={!!focus && focus.indices[0] === i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────── */

interface Props {
  projectSlug: string;
  row: RequestItem;
  appSlugs?: string[];
  environment?: string;
  since: string;
  until?: string;
  onClose: () => void;
  onFilterConsumer?: (consumer: string) => void;
}

export default function RequestLogDetailModal({
  projectSlug,
  row,
  appSlugs = [],
  environment,
  since,
  until,
  onClose,
  onFilterConsumer,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("details");
  // Exceptions the tab should open (set by a span badge click in the Trace
  // tab); cleared on a manual tab change so the default view returns.
  const [excFocus, setExcFocus] = useState<{ indices: number[]; token: number } | null>(null);
  const [payload, setPayload] = useState<PayloadRow | null | "loading">("loading");
  // A related request opened on top of this one (stacked modal).
  const [relatedOpen, setRelatedOpen] = useState<RequestItem | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // When a stacked child modal is open, let it handle Escape.
      if (e.key === "Escape" && !relatedOpen) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, relatedOpen]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Lazy-fetch the body/headers for this request via endpoint-requests
  // (the flat list query doesn't carry them). Match by closest timestamp.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = new URLSearchParams();
        p.set("method", row.method);
        p.set("path", row.path);
        if (appSlugs.length) p.set("app_slugs", appSlugs.join(","));
        if (environment) p.set("environment", environment);
        p.set("since", since);
        if (until) p.set("until", until);
        p.set("limit", "100");
        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoint-requests?${p.toString()}`);
        if (!res.ok) { if (!cancelled) setPayload(null); return; }
        const rows: PayloadRow[] = await res.json();
        const target = new Date(row.timestamp).getTime();
        let best: PayloadRow | null = null;
        let bestDiff = Infinity;
        for (const r of rows) {
          if (r.status_code !== row.status_code) continue;
          const diff = Math.abs(new Date(r.timestamp).getTime() - target);
          if (diff < bestDiff) { bestDiff = diff; best = r; }
        }
        if (!cancelled) setPayload(bestDiff <= 2000 ? best : null);
      } catch {
        if (!cancelled) setPayload(null);
      }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, row, appSlugs, environment, since, until]);

  const consumer = row.consumer_name || row.consumer_id || "";
  // Filter on the stable identifier, not the display name.
  const consumerFilter = row.consumer_id || row.consumer_name || "";
  const stext = StatusText(row.status_code);
  const loadingPayload = payload === "loading";
  const pr = payload && payload !== "loading" ? payload : null;
  // The list row carries trace_id for fresh data; fall back to the lazily
  // fetched detail row (older list responses don't include it).
  const traceId = (row.trace_id || pr?.trace_id || "").trim();

  // Exception logs correlated with this request via trace_id. Fetched at the
  // modal level (not inside a tab) so the Exceptions tab badge shows without
  // having to open the tab first.
  const [traceLogs, setTraceLogs] = useState<LogItem[] | null>(null);
  useEffect(() => {
    if (!traceId) { setTraceLogs(null); return; }
    let cancelled = false;
    setTraceLogs(null);
    (async () => {
      try {
        const p = new URLSearchParams();
        p.set("trace_id", traceId);
        p.set("since", since);
        if (until) p.set("until", until);
        if (environment) p.set("environment", environment);
        if (appSlugs.length) p.set("app_slugs", appSlugs.join(","));
        p.set("page_size", "100");
        const res = await fetch(`/api/projects/${projectSlug}/data/logs?${p.toString()}`);
        const data = res.ok ? await res.json() : { items: [] };
        if (cancelled) return;
        const items: LogItem[] = (data.items || []).slice();
        // The API returns newest-first; a single request's logs read naturally
        // in chronological order.
        items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        setTraceLogs(items);
      } catch { if (!cancelled) setTraceLogs([]); }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, traceId, appSlugs, environment, since, until]);
  // Only error-level lines count as exceptions (APILens auto-logs ERROR on an
  // unhandled exception or 5xx response).
  const exceptionLogs = traceLogs
    ? traceLogs.filter((l) => {
        const lv = (l.level || "").toUpperCase();
        return lv === "ERROR" || lv === "CRITICAL";
      })
    : null;
  const exceptionCount = exceptionLogs ? exceptionLogs.length : 0;

  const [copiedTrace, setCopiedTrace] = useState(false);
  const copyTrace = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopiedTrace(true);
      setTimeout(() => setCopiedTrace(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const curl = useMemo(() => {
    const base = (pr?.base_url || "").replace(/\/$/, "") || "YOUR_BASE_URL";
    const body = formatPayload(pr?.request_payload);
    const lines = [`curl -X ${row.method} "${base}${reqUrl(row)}"`];
    if (body) {
      lines.push(`  -H "Content-Type: application/json"`);
      lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
    }
    return lines.join(" \\\n");
  }, [pr, row]);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(curl);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const content = (
    <div className="ep-emodal-overlay" onClick={onClose}>
      <div className="ep-emodal ep-emodal--narrow" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ep-emodal-head">
          <div className="ep-emodal-id">
            <span className="ep-emodal-crumb">Request details</span>
            <span className={`endpoint-status-pill ${statusTone(row.status_code)}`}>{row.status_code}</span>
            <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
            <span className="ep-emodal-path">{reqUrl(row)}</span>
          </div>
          <div className="ep-emodal-headactions">
            <button type="button" className="ep-rl-curl" onClick={copyCurl} title="Copy as cURL">
              {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
              <span>{copiedCurl ? "Copied" : "cURL"}</span>
            </button>
            <button type="button" className="ep-emodal-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <nav className="ep-emodal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={activeTab === t.key}
              className={`ep-emodal-tab${activeTab === t.key ? " is-active" : ""}`}
              onClick={() => { setExcFocus(null); setActiveTab(t.key); }}
            >
              {t.label}
              {t.key === "exceptions" && exceptionCount > 0 ? (
                <span className="ep-rl-count ep-tab-count--error">{exceptionCount}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="ep-emodal-body">
          {activeTab === "details" && (
            <>
              <div className="ep-rl-when">{formatDateTime(row.timestamp)}</div>
              <div className="ep-statcards ep-rl-metrics">
                <MetricCard label="Request size" icon={<ArrowUpFromLine size={16} />} value={formatBytes(row.request_size)} />
                <MetricCard label="Response size" icon={<ArrowDownToLine size={16} />} value={formatBytes(row.response_size)} />
                <MetricCard label="Response time" icon={<Timer size={16} />} value={formatMs(row.response_time_ms)} />
              </div>
              <div className="ep-rl-details">
                <DetailRow label="Status" value={`${row.status_code}${stext ? ` ${stext}` : ""}`} />
                {pr?.base_url ? <DetailRow label="Host" value={<span className="ep-rl-mono"><Server size={12} /> {pr.base_url}</span>} /> : null}
                <DetailRow label="Client" value={<span className="ep-rl-mono"><Globe size={12} /> {row.ip_address || "—"}{pr?.country ? ` (${pr.country})` : ""}</span>} />
                <DetailRow
                  label="Consumer"
                  value={
                    consumer ? (
                      onFilterConsumer ? (
                        <button
                          type="button"
                          className="ep-rl-mono ep-rl-consumer-link"
                          title={`Show all requests from ${consumer}`}
                          onClick={() => onFilterConsumer(consumerFilter)}
                        >
                          <Fingerprint size={12} /> {consumer}{row.consumer_group ? ` · ${row.consumer_group}` : ""}
                        </button>
                      ) : (
                        <span className="ep-rl-mono"><Fingerprint size={12} /> {consumer}{row.consumer_group ? ` · ${row.consumer_group}` : ""}</span>
                      )
                    ) : "—"
                  }
                />
                <DetailRow label="Environment" value={row.environment || "—"} />
                {traceId ? (
                  <DetailRow
                    label="Trace"
                    value={
                      <button
                        type="button"
                        className="ep-rl-mono ep-rl-consumer-link"
                        title="Copy trace id"
                        onClick={copyTrace}
                      >
                        <Link2 size={12} /> {traceId} {copiedTrace ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    }
                  />
                ) : null}
                {row.user_agent ? <DetailRow label="User agent" value={<span className="ep-rl-ua">{row.user_agent}</span>} /> : null}
              </div>
            </>
          )}

          {activeTab === "headers" && (
            loadingPayload ? (
              <div className="endpoint-skeleton" style={{ height: 160 }} aria-hidden />
            ) : (
              <>
                <HeadersList title="Request headers" raw={pr?.request_headers} />
                <HeadersList title="Response headers" raw={pr?.response_headers} />
              </>
            )
          )}

          {activeTab === "response" && (
            loadingPayload ? (
              <div className="endpoint-skeleton" style={{ height: 220 }} aria-hidden />
            ) : (
              <>
                <Body title="Request payload" raw={pr?.request_payload} />
                <Body title="Response payload" raw={pr?.response_payload} />
              </>
            )
          )}

          {activeTab === "trace" && (
            <TraceTab
              projectSlug={projectSlug}
              traceId={traceId}
              loadingTrace={loadingPayload}
              exceptionLogs={exceptionLogs}
              onOpenExceptions={(indices) => {
                setExcFocus(indices.length ? { indices, token: Date.now() } : null);
                setActiveTab("exceptions");
              }}
            />
          )}

          {activeTab === "exceptions" && (
            <ExceptionsTab
              logs={exceptionLogs}
              traceId={traceId}
              loadingTrace={loadingPayload}
              focus={excFocus}
            />
          )}

          {activeTab === "related" && (
            <RelatedTab
              projectSlug={projectSlug}
              row={row}
              appSlugs={appSlugs}
              environment={environment}
              since={since}
              until={until}
              onOpen={setRelatedOpen}
            />
          )}
        </div>
      </div>

      {/* Stacked modal for a clicked related request */}
      {relatedOpen && (
        <RequestLogDetailModal
          projectSlug={projectSlug}
          row={relatedOpen}
          appSlugs={appSlugs}
          environment={environment}
          since={since}
          until={until}
          onClose={() => setRelatedOpen(null)}
        />
      )}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
