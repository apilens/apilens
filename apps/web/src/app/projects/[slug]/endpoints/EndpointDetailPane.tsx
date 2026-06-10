"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Check, ChevronRight, Clock, FileX2, Globe, MonitorSmartphone, Search, Terminal, User } from "lucide-react";
import type { IconType } from "react-icons";
import {
  SiAxios,
  SiBrave,
  SiCurl,
  SiFirefoxbrowser,
  SiGo,
  SiGooglechrome,
  SiHttpie,
  SiInsomnia,
  SiNodedotjs,
  SiOpera,
  SiPostman,
  SiPython,
  SiSafari,
} from "react-icons/si";

/* ── Types ───────────────────────────────────────────────────────────── */

interface EndpointDetail {
  method: string;
  path: string;
  description: string;
  total_requests: number;
  successful_requests: number;
  client_errors: number;
  server_errors: number;
  error_count: number;
  error_rate: number;
  requests_per_minute: number;
  avg_response_time_ms: number;
  p50_response_time_ms: number;
  p75_response_time_ms: number;
  p95_response_time_ms: number;
  slow_requests: number;
  apdex: number;
  threshold_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  total_data_transferred: number;
  avg_response_size: number;
  last_seen_at: string | null;
  base_url?: string;
}

interface RequestRow {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer: string;
  consumer_id?: string;
  consumer_name?: string;
  user_agent?: string;
  ip_address?: string;
  country?: string;
  country_code?: string;
  request_payload?: string;
  response_payload?: string;
  base_url?: string;
}

type StatTone = "good" | "warn" | "bad";
type FilterTab = "all" | "2xx" | "4xx" | "5xx";

const EMPTY_DETAIL: EndpointDetail = {
  method: "",
  path: "",
  description: "",
  total_requests: 0,
  successful_requests: 0,
  client_errors: 0,
  server_errors: 0,
  error_count: 0,
  error_rate: 0,
  requests_per_minute: 0,
  avg_response_time_ms: 0,
  p50_response_time_ms: 0,
  p75_response_time_ms: 0,
  p95_response_time_ms: 0,
  slow_requests: 0,
  apdex: 0,
  threshold_ms: 0,
  total_request_bytes: 0,
  total_response_bytes: 0,
  total_data_transferred: 0,
  avg_response_size: 0,
  last_seen_at: null,
};

/* ── Helpers ─────────────────────────────────────────────────────────── */

function methodPillClass(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "ep-pill-get";
  if (k === "POST") return "ep-pill-post";
  if (k === "PUT") return "ep-pill-put";
  if (k === "PATCH") return "ep-pill-patch";
  if (k === "DELETE") return "ep-pill-delete";
  if (k === "HEAD") return "ep-pill-head";
  if (k === "OPTIONS") return "ep-pill-options";
  return "ep-pill-other";
}

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}
function fmtMs(n: number): string {
  if (!n) return "0 ms";
  return `${Math.round(n)} ms`;
}
function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function byteLen(s?: string): number {
  if (!s) return 0;
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}
const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  409: "Conflict", 410: "Gone", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
function statusText(code: number): string {
  return STATUS_TEXT[code] || "";
}
function fmtDateTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtTimeShort(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function statusDotClass(status: number): string {
  if (status >= 500) return "ep-status-dot-5xx";
  if (status >= 400) return "ep-status-dot-4xx";
  if (status >= 300) return "ep-status-dot-3xx";
  return "ep-status-dot-2xx";
}
function timeAgo(ts: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ── API source detection ─────────────────────────────────────────────
   The call's origin, auto-detected from the user-agent (a browser, an API
   client like Postman/Insomnia, or an SDK). This is NOT the "consumer" (a
   user identity set by middleware) — it's how the request was actually made.
   Returns null when the user-agent is missing or unrecognised, so the caller
   renders nothing rather than a placeholder. */

/** ISO-3166 alpha-2 → flag emoji (regional indicator symbols). */
function flagEmoji(code?: string): string {
  if (!code || code.length !== 2 || !/^[a-zA-Z]{2}$/.test(code)) return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => base + c.charCodeAt(0) - 65),
  );
}

type LocationKind = "country" | "local" | "private" | "unknown";

/** Human-readable origin for a request. Geo lookups can't place loopback /
 *  private IPs (e.g. 127.0.0.1 in local dev), so fall back to a sensible label
 *  instead of showing nothing. */
function describeLocation(
  ip?: string,
  country?: string,
  code?: string,
): { label: string; flag: string; kind: LocationKind } | null {
  if (country) return { label: country, flag: flagEmoji(code), kind: "country" };
  const addr = (ip || "").replace(/^::ffff:/i, "");
  if (!addr) return null;
  if (addr === "127.0.0.1" || addr === "::1" || addr === "localhost") {
    return { label: "Localhost", flag: "", kind: "local" };
  }
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(addr)) {
    return { label: "Private network", flag: "", kind: "private" };
  }
  return { label: "Unknown", flag: "", kind: "unknown" };
}

interface SourceInfo {
  name: string;
  Icon: IconType | null; // null = recognised but no brand mark → generic globe
  color: string;
}

function detectSource(ua: string | undefined): SourceInfo | null {
  if (!ua) return null;
  // API clients / SDKs first — their UAs often also carry browser-ish tokens.
  if (/PostmanRuntime|Postman/i.test(ua)) return { name: "Postman", Icon: SiPostman, color: "#FF6C37" };
  if (/insomnia/i.test(ua)) return { name: "Insomnia", Icon: SiInsomnia, color: "#7263E6" };
  if (/HTTPie/i.test(ua)) return { name: "HTTPie", Icon: SiHttpie, color: "#7ED99A" };
  if (/\bcurl\//i.test(ua)) return { name: "curl", Icon: SiCurl, color: "#8aa0b6" };
  if (/axios/i.test(ua)) return { name: "axios", Icon: SiAxios, color: "#9277F0" };
  if (/python-requests|aiohttp|httpx|Python\//i.test(ua)) return { name: "Python", Icon: SiPython, color: "#5A9FD4" };
  if (/Go-http-client/i.test(ua)) return { name: "Go", Icon: SiGo, color: "#00ADD8" };
  if (/node|undici|node-fetch/i.test(ua)) return { name: "Node", Icon: SiNodedotjs, color: "#5FA04E" };
  // Browsers — order matters (Edge/Opera/Brave masquerade as Chrome).
  if (/Edg\//.test(ua)) return { name: "Edge", Icon: null, color: "#3DA7E0" };
  if (/OPR\/|Opera/i.test(ua)) return { name: "Opera", Icon: SiOpera, color: "#FF1B2D" };
  if (/Brave/i.test(ua)) return { name: "Brave", Icon: SiBrave, color: "#FB702E" };
  if (/Firefox\//.test(ua)) return { name: "Firefox", Icon: SiFirefoxbrowser, color: "#FF7139" };
  if (/Chrome\//.test(ua)) return { name: "Chrome", Icon: SiGooglechrome, color: "#5A9CF8" };
  if (/Safari\//.test(ua)) return { name: "Safari", Icon: SiSafari, color: "#22B5F0" };
  return null; // unrecognised — render nothing
}

/** Microsoft Edge — no open-licensed brand mark in the icon set, so we draw the
 *  Edge swirl inline rather than falling back to a generic globe. */
function EdgeIcon({ size = 13, color = "#3DA7E0" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7.5" fill={color} />
      <path d="M3.6 7.3C4.2 4.9 6.3 3.3 8.9 3.3c2 0 3.5 1.1 3.5 2.7 0 1.3-1 2.1-2.5 2.1H6.4"
        fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3.8 8.6c-.1 2.3 1.9 4.1 4.6 4.1 1.6 0 3-.6 3.9-1.6"
        fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Renders the detected call source (brand icon + name). Renders nothing when
 *  the source can't be determined. */
function Source({ ua, size = 13, showName = true }: { ua?: string; size?: number; showName?: boolean }) {
  const src = detectSource(ua);
  if (!src) return null;
  return (
    <span className="ep-source" title={src.name}>
      {src.name === "Edge"
        ? <EdgeIcon size={size} color={src.color} />
        : src.Icon
          ? <src.Icon size={size} color={src.color} />
          : <Globe size={size} color={src.color} />}
      {showName && <span className="ep-source-name">{src.name}</span>}
    </span>
  );
}

/* ── Props ───────────────────────────────────────────────────────────── */

type FocusZone = "list" | "calls";

interface EndpointDetailPaneProps {
  projectSlug: string;
  method: string;
  path: string;
  since: string;
  until?: string;
  environment?: string;
  appSlugs?: string[];
  onBack?: () => void;
  focusZone?: FocusZone;
  onFocusZoneChange?: (zone: FocusZone) => void;
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function EndpointDetailPane({
  projectSlug,
  method,
  path,
  since,
  until,
  environment,
  appSlugs = [],
  onBack,
  focusZone = "list",
  onFocusZoneChange,
}: EndpointDetailPaneProps) {
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestRow[] | null>(null);

  const loadingRef = useRef<Set<string>>(new Set());
  const reqIdRef = useRef(0);
  const [, forceRender] = useState(0);

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("method", method);
    params.set("path", path);
    if (appSlugs.length) params.set("app_slugs", appSlugs.join(","));
    params.set("since", since);
    if (until) params.set("until", until);
    if (environment) params.set("environment", environment);
    return params;
  }, [method, path, appSlugs, since, until, environment]);

  useEffect(() => {
    reqIdRef.current += 1;
    setDetail(null);
    setRecentRequests(null);
    loadingRef.current = new Set();
  }, [baseParams]);

  const fetchResource = useCallback(
    async <T,>(
      key: string,
      endpointPath: string,
      setter: (val: T) => void,
      emptyValue: T,
      extra?: Record<string, string>,
    ) => {
      if (loadingRef.current.has(key)) return;
      loadingRef.current.add(key);
      const reqId = reqIdRef.current;
      forceRender((n) => n + 1);
      try {
        const params = new URLSearchParams(baseParams);
        if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
        const res = await fetch(`/api/projects/${projectSlug}/analytics/${endpointPath}?${params.toString()}`);
        if (reqId !== reqIdRef.current) return;
        setter(res.ok ? ((await res.json()) as T) : emptyValue);
      } catch {
        if (reqId === reqIdRef.current) setter(emptyValue);
      } finally {
        loadingRef.current.delete(key);
        forceRender((n) => n + 1);
      }
    },
    [baseParams, projectSlug],
  );

  useEffect(() => {
    if (!method || !path) return;
    if (detail === null) fetchResource<EndpointDetail>("detail", "endpoint-detail", setDetail, EMPTY_DETAIL);
    if (recentRequests === null) fetchResource<RequestRow[]>("requests", "endpoint-requests", setRecentRequests, [], { limit: "100" });
  }, [method, path, detail, recentRequests, fetchResource]);

  const errRate = detail?.error_rate || 0;
  const p95 = detail?.p95_response_time_ms || 0;
  const threshold = detail?.threshold_ms || 0;
  const apdex = detail?.apdex || 0;
  const loading = detail === null;

  const errTone: StatTone | undefined = loading ? undefined : errRate >= 5 ? "bad" : errRate >= 1 ? "warn" : "good";
  const apdexTone: StatTone | undefined = loading ? undefined : apdex >= 0.94 ? "good" : apdex >= 0.85 ? "warn" : "bad";
  const p95Tone: StatTone | undefined =
    loading || !threshold ? undefined : p95 > threshold ? "bad" : p95 > threshold * 0.75 ? "warn" : "good";

  return (
    <div className="ep-detail-content">

      {/* ── Header: endpoint identity on the left, metrics on the right ── */}
      <div className="ep-api-header">
        <div className="ep-api-id">
          {onBack && (
            <button type="button" onClick={onBack} className="ep-api-back" aria-label="Back">
              <ArrowLeft size={15} />
            </button>
          )}
          <span className={`ep-method-pill ${methodPillClass(method)}`}>{method}</span>
          <span className="ep-api-path">{path}</span>
          {detail?.last_seen_at && <span className="ep-api-age">{timeAgo(detail.last_seen_at)}</span>}
        </div>

        {/* Golden signals + throughput, right-aligned. Wraps; no scroll. */}
        <div className="ep-metrics-bar">
          <Metric label="req" value={loading ? "—" : fmtNum(detail!.total_requests)} title="Total requests" />
          <Metric label="rpm" value={loading ? "—" : `${(detail!.requests_per_minute || 0).toFixed(1)}`} title="Requests per minute" />
          <Metric label="errors" tone={errTone} value={loading ? "—" : `${errRate.toFixed(2)}%`} title="Error rate" />
          <Metric label="p50" value={loading ? "—" : fmtMs(detail!.p50_response_time_ms)} title="Median response time" />
          <Metric label="p95" tone={p95Tone} value={loading ? "—" : fmtMs(p95)} title="95th-percentile response time" />
          <Metric label="Apdex" tone={apdexTone} value={loading ? "—" : apdex.toFixed(3)} title="Apdex score" />
          <Metric label="data" value={loading ? "—" : fmtBytes(detail!.total_data_transferred)} title="Total data transferred (request + response)" />
          <Metric label="avg" value={loading ? "—" : fmtBytes(detail!.avg_response_size)} title="Average response size" />
        </div>
      </div>

      {/* ── Individual calls — the primary content ─────────────────── */}
      <CallsPane
        requests={recentRequests}
        baseUrl={detail?.base_url || ""}
        focusZone={focusZone}
        onFocusZoneChange={onFocusZoneChange}
        lastSeenAt={detail?.last_seen_at ?? null}
        totalRequests={detail?.total_requests ?? 0}
      />
    </div>
  );
}

/* ── Flat metric (number + spaced label) ─────────────────────────────── */

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: StatTone; title?: string }) {
  return (
    <span
      className={`ep-metrics-item${tone === "bad" ? " tone-bad" : tone === "warn" ? " tone-warn" : ""}`}
      title={title}
    >
      <span className="ep-metrics-n">{value}</span>
      <span className="ep-metrics-l">{label}</span>
    </span>
  );
}

/* ── Calls pane ──────────────────────────────────────────────────────── */

function CallsPane({
  requests,
  baseUrl,
  focusZone = "list",
  onFocusZoneChange,
  lastSeenAt = null,
  totalRequests = 0,
}: {
  requests: RequestRow[] | null;
  baseUrl: string;
  focusZone?: FocusZone;
  onFocusZoneChange?: (zone: FocusZone) => void;
  lastSeenAt?: string | null;
  totalRequests?: number;
}) {
  const [selected, setSelected] = useState<RequestRow | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!requests) return null;
    return requests.filter((r) => {
      const passTab =
        tab === "all" ||
        (tab === "2xx" && r.status_code >= 200 && r.status_code < 300) ||
        (tab === "4xx" && r.status_code >= 400 && r.status_code < 500) ||
        (tab === "5xx" && r.status_code >= 500);
      if (!passTab) return false;
      if (!query) return true;
      const source = detectSource(r.user_agent)?.name || "";
      return source.toLowerCase().includes(query.toLowerCase());
    });
  }, [requests, tab, query]);

  // Restart at the top whenever the underlying list changes.
  useEffect(() => {
    setCursor(0);
  }, [requests, tab, query]);

  // The detail pane follows the cursor: it auto-opens the first call when the
  // list loads and always shows the highlighted call as you move. There's no
  // open/close state — the third pane stays populated while calls exist.
  useEffect(() => {
    setSelected(filtered && filtered.length ? filtered[Math.min(cursor, filtered.length - 1)] : null);
  }, [filtered, cursor]);

  // Don't sit in an empty zone: if this endpoint has no calls at all, hand focus
  // back to the endpoints list (there's nothing to navigate here). Guard on the
  // raw request list — not the filtered one — so an empty search result while
  // you're typing doesn't bounce you out.
  useEffect(() => {
    if (focusZone === "calls" && requests !== null && requests.length === 0) {
      onFocusZoneChange?.("list");
    }
  }, [focusZone, requests, onFocusZoneChange]);

  // ── Keyboard navigation for the calls pane ──
  // ↑/↓ move through calls (the detail follows the cursor); ←/Esc return to the
  // endpoints list. No open/close — the detail stays shown while calls exist.
  useEffect(() => {
    if (focusZone !== "calls") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "Escape") {
        e.preventDefault();
        onFocusZoneChange?.("list");
        return;
      }
      const list = filtered;
      if (!list || !list.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusZone, filtered, onFocusZoneChange]);

  // Keep the keyboard cursor scrolled into view.
  useEffect(() => {
    if (focusZone !== "calls") return;
    listRef.current?.querySelector(".ep-call-row.is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor, focusZone, filtered]);

  return (
    <div className={`ep-calls-pane${selected ? " has-detail" : ""}`}>
      <div className="ep-calls-main">
      {/* Filter bar */}
      <div className="ep-calls-filter">
        <div className="ep-calls-tabs">
          {(["all", "2xx", "4xx", "5xx"] as FilterTab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`ep-calls-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "all" ? "All" : t}
            </button>
          ))}
        </div>
        <div className="ep-calls-search">
          <Search size={12} />
          <input
            placeholder="source…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // ↓ from the search box drops the cursor into the call list.
              if (e.key === "ArrowDown" && filtered && filtered.length) {
                e.preventDefault();
                setCursor(0);
                onFocusZoneChange?.("calls");
                e.currentTarget.blur();
              } else if (e.key === "Enter" && filtered && filtered.length) {
                e.preventDefault();
                setCursor(0);
                setSelected(filtered[0]);
                onFocusZoneChange?.("calls");
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      </div>

      {/* Call list */}
      <div className="ep-calls-list" ref={listRef}>
        {filtered === null ? (
          <div className="ep-calls-empty">Loading calls…</div>
        ) : filtered.length === 0 ? (
          requests !== null && requests.length === 0 ? (
            /* Endpoint truly has no traffic in this window */
            <div className="ep-no-calls">
              {totalRequests === 0 && !lastSeenAt ? (
                <Activity size={28} className="ep-no-calls-icon" />
              ) : (
                <Clock size={28} className="ep-no-calls-icon" />
              )}
              <p className="ep-no-calls-title">
                {totalRequests === 0 && !lastSeenAt
                  ? "No requests tracked yet"
                  : "No requests in this period"}
              </p>
              {lastSeenAt ? (
                <span className="ep-no-calls-sub">Last active {timeAgo(lastSeenAt)}</span>
              ) : totalRequests > 0 ? (
                <span className="ep-no-calls-sub">Try expanding the time range</span>
              ) : (
                <span className="ep-no-calls-sub">Requests will appear here once your API receives traffic</span>
              )}
            </div>
          ) : (
            /* Has requests but the current tab/search filter shows nothing */
            <div className="ep-calls-empty">No requests match this filter.</div>
          )
        ) : (
          filtered.map((r, i) => (
            <button
              key={`${r.timestamp}-${i}`}
              type="button"
              className={`ep-call-row${i === cursor ? (focusZone === "calls" ? " is-cursor" : " is-active") : ""}`}
              onClick={() => {
                setCursor(i);
                setSelected(r);
                onFocusZoneChange?.("calls");
              }}
            >
              <span className="ep-call-time">{fmtTimeShort(r.timestamp)}</span>
              <span className={`ep-call-status ${statusDotClass(r.status_code)}`}>
                {r.status_code}
              </span>
              <span className="ep-call-dur">{fmtMs(r.response_time_ms)}</span>
              <span className={`ep-call-consumer${(r.consumer_name || r.consumer_id) ? "" : " is-empty"}`}>
                {r.consumer_name || r.consumer_id || "—"}
              </span>
              {r.environment && (
                <span className="ep-call-env">{r.environment}</span>
              )}
              <span className="ep-call-arrow">
                <ChevronRight size={13} />
              </span>
            </button>
          ))
        )}
      </div>
      </div>

      {/* Third pane — individual call analysis, follows the cursor (always shown) */}
      {selected && (
        <CallDetailInline
          key={`${selected.timestamp}-${selected.status_code}`}
          row={selected}
          baseUrl={baseUrl}
        />
      )}
    </div>
  );
}

/* ── Call payload rendering ───────────────────────────────────────────── */

// Saved base-URL fallback (key kept for back-compat with the old cURL override).
const CURL_BASE_URL_KEY = "apilens:curl-base-url";

function buildCurl(row: RequestRow, baseUrl: string): string {
  const base = (baseUrl || "").replace(/\/$/, "") || "YOUR_BASE_URL";
  const body = formatPayload(row.request_payload);
  const lines: string[] = [`curl -X ${row.method} "${base}${row.path}"`];
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join(" \\\n");
}

function formatPayload(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function highlightJson(json: string): string {
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(
    /("(?:[^"\\]|\\.)*"(?:\s*:)?|(?<!["\w])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?!["\w])|\btrue\b|\bfalse\b|\bnull\b)/g,
    (match) => {
      if (match.endsWith(":")) return `<span class="json-key">${match}</span>`;
      if (match.startsWith('"')) return `<span class="json-string">${match}</span>`;
      if (match === "true" || match === "false") return `<span class="json-bool">${match}</span>`;
      if (match === "null") return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    },
  );
}

/** Read-only payload body (Postman-style) — JSON syntax-highlighted, no chrome. */
function PayloadBody({ body }: { body: string }) {
  if (!body) {
    return (
      <div className="request-payload-empty">
        <FileX2 size={16} strokeWidth={1.5} />
        <span>No body</span>
      </div>
    );
  }
  const isJson = (() => {
    try { JSON.parse(body); return true; } catch { return false; }
  })();
  return isJson ? (
    <pre className="request-payload-pre" dangerouslySetInnerHTML={{ __html: highlightJson(body) }} />
  ) : (
    <pre className="request-payload-pre">{body}</pre>
  );
}

/* ── Inline call detail (no overlay — lives on the page) ──────────────── */

function CallDetailInline({
  row,
  baseUrl: detectedBaseUrl,
}: {
  row: RequestRow;
  baseUrl: string;
}) {
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window === "undefined") return detectedBaseUrl;
    return localStorage.getItem(CURL_BASE_URL_KEY) || detectedBaseUrl;
  });

  useEffect(() => {
    if (detectedBaseUrl && !localStorage.getItem(CURL_BASE_URL_KEY)) {
      setBaseUrl(detectedBaseUrl);
    }
  }, [detectedBaseUrl]);

  // Prefer the base_url the SDK captured for THIS call (dev/prod/staging can
  // differ per request); fall back to the endpoint-level / saved override.
  const callBaseUrl = row.base_url || baseUrl;
  const fullUrl = `${(callBaseUrl || "").replace(/\/$/, "")}${row.path}`;

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(row, callBaseUrl));
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const source = detectSource(row.user_agent);
  const loc = describeLocation(row.ip_address, row.country, row.country_code);
  const consumerLabel = row.consumer_name || row.consumer_id || "";
  const hasFacts = !!(consumerLabel || source || loc || row.ip_address);
  const reqBody = formatPayload(row.request_payload);
  const respBody = formatPayload(row.response_payload);
  const stext = statusText(row.status_code);

  return (
    <div className="ep-call-detail">
      {/* Postman-style request bar: method + full URL + Copy cURL action */}
      <div className="ep-pm-reqbar">
        <span className={`ep-method-pill ${methodPillClass(row.method)}`}>{row.method}</span>
        <span className="ep-pm-url" title={fullUrl}>{fullUrl}</span>
        <button
          type="button"
          className="ep-pm-curl"
          onClick={copyCurl}
          title="Copy as cURL"
          aria-label="Copy as cURL"
        >
          {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
          <span>{copiedCurl ? "Copied" : "cURL"}</span>
        </button>
      </div>

      {(hasFacts || row.timestamp) && (
        <div className="ep-call-req-facts ep-pm-facts">
          <span className="ep-fact ep-fact-mono ep-fact-when">{fmtDateTime(row.timestamp)}</span>
          {consumerLabel && (
            <span className="ep-fact ep-fact-consumer" title="Consumer — the user identity set by your middleware">
              <User size={12} className="ep-meta-icon" />{consumerLabel}
            </span>
          )}
          {source && <span className="ep-fact"><Source ua={row.user_agent} size={13} /></span>}
          {loc && (
            <span className="ep-fact">
              {loc.flag ? (
                <span className="ep-call-detail-flag">{loc.flag}</span>
              ) : loc.kind === "local" ? (
                <MonitorSmartphone size={12} className="ep-meta-icon" />
              ) : (
                <Globe size={12} className="ep-meta-icon" />
              )}
              {loc.label}
            </span>
          )}
          {row.ip_address && <span className="ep-fact ep-fact-mono">{row.ip_address}</span>}
        </div>
      )}

      <div className="ep-pm-body">
        {/* Request body */}
        <section className="ep-pm-pane">
          <div className="ep-pm-pane-head">
            <span className="ep-pm-pane-title">Request</span>
            <span className="ep-pm-pane-meta">{fmtBytes(byteLen(row.request_payload))}</span>
          </div>
          <PayloadBody body={reqBody} />
        </section>

        {/* Response — status / time / size in the upper bar, Postman-style */}
        <section className="ep-pm-pane">
          <div className="ep-pm-pane-head ep-pm-resp-head">
            <span className="ep-pm-pane-title">Response</span>
            <span className="ep-pm-respbar">
              <span className={`ep-pm-status ${statusDotClass(row.status_code)}`}>
                <span className="ep-pm-status-dot" />
                {row.status_code}{stext ? ` ${stext}` : ""}
              </span>
              <span className="ep-pm-resp-meta">{fmtMs(row.response_time_ms)}</span>
              <span className="ep-pm-resp-meta">{fmtBytes(byteLen(row.response_payload))}</span>
            </span>
          </div>
          <PayloadBody body={respBody} />
        </section>
      </div>
    </div>
  );
}
