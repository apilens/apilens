"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, Copy, Search, Terminal } from "lucide-react";
import {
  Button,
  StatusPill,
  statusCodeTone,
} from "@/components/aperture";

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
  request_payload?: string;
  response_payload?: string;
}

type StatTone = "good" | "warn" | "bad";
type FilterTab = "all" | "2xx" | "4xx" | "5xx";
type BrowserType = "chrome" | "firefox" | "safari" | "edge" | "postman" | "curl" | "other";

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

function detectBrowser(ua: string): { type: BrowserType; name: string } {
  if (!ua) return { type: "other", name: "Unknown" };
  if (/Postman/.test(ua)) return { type: "postman", name: "Postman" };
  if (/curl\//.test(ua)) return { type: "curl", name: "curl" };
  if (/Edg\//.test(ua)) return { type: "edge", name: "Edge" };
  if (/Chrome\//.test(ua)) return { type: "chrome", name: "Chrome" };
  if (/Firefox\//.test(ua)) return { type: "firefox", name: "Firefox" };
  if (/Safari\//.test(ua)) return { type: "safari", name: "Safari" };
  return { type: "other", name: "Browser" };
}

function BrowserIcon({ ua, size = 14 }: { ua?: string; size?: number }) {
  if (!ua) return null;
  const { type, name } = detectBrowser(ua);
  const s = size;

  const icon = (() => {
    switch (type) {
      case "chrome":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#EA4335" />
            <path d="M8 8 L8 .5 A7.5 7.5 0 0 1 15.5 8 Z" fill="#FBBC05" />
            <path d="M8 8 L15.5 8 A7.5 7.5 0 0 1 4.25 14.5 Z" fill="#34A853" />
            <circle cx="8" cy="8" r="3.8" fill="white" />
            <circle cx="8" cy="8" r="2.8" fill="#4285F4" />
          </svg>
        );
      case "firefox":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#FF6611" />
            <circle cx="8" cy="8" r="4.5" fill="#FF9500" />
            <circle cx="8" cy="8" r="2.2" fill="#FF3750" />
          </svg>
        );
      case "safari":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#006CFF" />
            <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" />
            <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="rgba(255,255,255,0.2)" strokeWidth="0.6" />
            <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="rgba(255,255,255,0.2)" strokeWidth="0.6" />
            <polygon points="8,3 9.3,8 8,7.1" fill="#FF3B30" />
            <polygon points="8,13 6.7,8 8,8.9" fill="white" />
          </svg>
        );
      case "edge":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#0078D4" />
            <path d="M5.5 5.5 C5.5 3.5 7 2.5 8.5 2.5 C11 2.5 13 4.5 13 7 C13 9 11.5 10.5 9.5 11 C8.8 11.2 7.5 11.3 7 11" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            <path d="M4.5 11.5 C4.5 13 6.5 14 8.5 14 C10 14 11.5 13.3 12 12.5" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            <path d="M4.5 11.5 C6.5 12.2 11 11.8 12 10.8" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </svg>
        );
      case "postman":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#FF6C37" />
            <text x="8" y="11.5" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="sans-serif">P</text>
          </svg>
        );
      case "curl":
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#374151" />
            <text x="8.5" y="11" textAnchor="middle" fill="#9CA3AF" fontSize="6.5" fontFamily="monospace" fontWeight="600">&gt;_</text>
          </svg>
        );
      default:
        return (
          <svg width={s} height={s} viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="7.5" fill="#4B5563" />
            <circle cx="8" cy="8" r="4.5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
            <line x1="8" y1="3" x2="8" y2="13" stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" />
            <path d="M3.8 5.8 Q8 4.2 12.2 5.8" stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" fill="none" />
            <path d="M3.8 10.2 Q8 11.8 12.2 10.2" stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" fill="none" />
          </svg>
        );
    }
  })();

  return (
    <span className="ep-browser-icon" title={`${name}: ${ua}`} aria-label={name}>
      {icon}
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

      {/* ── Header: method pill + path ─────────────────────────────── */}
      <div className="ep-api-header">
        {onBack && (
          <button type="button" onClick={onBack} className="ep-api-back" aria-label="Back">
            <ArrowLeft size={15} />
          </button>
        )}
        <span className={`ep-method-pill ${methodPillClass(method)}`}>{method}</span>
        <span className="ep-api-path">{path}</span>
        {detail?.base_url && <span className="ep-api-host">{detail.base_url}</span>}
        {detail?.last_seen_at && <span className="ep-api-age">{timeAgo(detail.last_seen_at)}</span>}
      </div>

      {/* ── Metrics: golden signals first, then throughput. Wraps; no scroll. */}
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

      {/* ── Individual calls — the primary content ─────────────────── */}
      <CallsPane
        requests={recentRequests}
        baseUrl={detail?.base_url || ""}
        focusZone={focusZone}
        onFocusZoneChange={onFocusZoneChange}
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
}: {
  requests: RequestRow[] | null;
  baseUrl: string;
  focusZone?: FocusZone;
  onFocusZoneChange?: (zone: FocusZone) => void;
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
      return (r.consumer || "").toLowerCase().includes(query.toLowerCase());
    });
  }, [requests, tab, query]);

  // Restart at the top whenever the underlying list changes.
  useEffect(() => {
    setCursor(0);
  }, [requests, tab, query]);

  // ── Keyboard navigation for the calls pane ──
  // List mode:   ↑/↓ move the cursor, Enter opens the inline detail, ←/Esc return to endpoints.
  // Detail open: ↑/↓ step through adjacent calls, ←/Esc close the detail (back to the list).
  useEffect(() => {
    if (focusZone !== "calls") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      const list = filtered;

      if (selected) {
        if (e.key === "Escape" || e.key === "ArrowLeft") {
          e.preventDefault();
          setSelected(null);
        } else if (list && list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const n =
            e.key === "ArrowDown"
              ? Math.min(cursor + 1, list.length - 1)
              : Math.max(cursor - 1, 0);
          setCursor(n);
          setSelected(list[n]);
        }
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "Escape") {
        e.preventDefault();
        onFocusZoneChange?.("list");
        return;
      }
      if (!list || !list.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = list[Math.min(cursor, list.length - 1)];
        if (row) setSelected(row);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusZone, selected, filtered, cursor, onFocusZoneChange]);

  // Keep the keyboard cursor scrolled into view.
  useEffect(() => {
    if (focusZone !== "calls") return;
    listRef.current?.querySelector(".ep-call-row.is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor, focusZone, filtered]);

  if (selected) {
    return (
      <div className="ep-calls-pane">
        <CallDetailInline
          key={`${selected.timestamp}-${selected.status_code}`}
          row={selected}
          baseUrl={baseUrl}
          onClose={() => setSelected(null)}
        />
      </div>
    );
  }

  return (
    <div className="ep-calls-pane">
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
            placeholder="consumer…"
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
          <div className="ep-calls-empty">No requests match.</div>
        ) : (
          filtered.map((r, i) => (
            <button
              key={`${r.timestamp}-${i}`}
              type="button"
              className={`ep-call-row${focusZone === "calls" && i === cursor ? " is-cursor" : ""}`}
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
              <span className="ep-call-consumer-cell">
                <BrowserIcon ua={r.user_agent} size={13} />
                <span className={`ep-call-consumer${(r.consumer_name || r.consumer_id) ? "" : " is-empty"}`}>
                  {r.consumer_name || r.consumer_id || "—"}
                </span>
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
  );
}

/* ── Request payload modal ───────────────────────────────────────────── */

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

function PayloadBlock({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  const isJson = !!body && (() => {
    try { JSON.parse(body); return true; } catch { return false; }
  })();
  return (
    <section className="request-payload-section">
      <div className="request-payload-section-head">
        <h4>{title}</h4>
        {body && (
          <button type="button" className="request-payload-copy" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {body ? (
        isJson ? (
          <pre className="request-payload-pre" dangerouslySetInnerHTML={{ __html: highlightJson(body) }} />
        ) : (
          <pre className="request-payload-pre">{body}</pre>
        )
      ) : (
        <div className="ep-calls-empty">No payload captured.</div>
      )}
    </section>
  );
}

/* ── Inline call detail (no overlay — lives on the page) ──────────────── */

function CallDetailInline({
  row,
  baseUrl: detectedBaseUrl,
  onClose,
}: {
  row: RequestRow;
  baseUrl: string;
  onClose: () => void;
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

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(row, baseUrl));
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="ep-call-detail">
      <div className="ep-call-detail-head">
        <button type="button" className="ep-call-detail-back" onClick={onClose} aria-label="Back to calls" title="Back (Esc)">
          <ArrowLeft size={15} />
        </button>
        <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
        <span className="ep-call-detail-path">{row.path}</span>
        <StatusPill tone={statusCodeTone(row.status_code)}>{row.status_code}</StatusPill>
        <div className="ep-call-detail-spacer" />
        <Button variant="secondary" size="sm" onClick={copyCurl} title="Copy as cURL" aria-label="Copy as cURL">
          {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
          {copiedCurl ? "Copied!" : "Copy cURL"}
        </Button>
      </div>
      <div className="request-payload-meta">
        <span>{fmtDateTime(row.timestamp)}</span>
        <span>·</span>
        <span>{fmtMs(row.response_time_ms)}</span>
        {row.user_agent && (
          <>
            <span>·</span>
            <span className="request-payload-meta-browser">
              <BrowserIcon ua={row.user_agent} size={13} />
              <span>{detectBrowser(row.user_agent).name}</span>
            </span>
          </>
        )}
        {(row.consumer_name || row.consumer_id) && (
          <><span>·</span><span className="request-payload-meta-consumer">{row.consumer_name || row.consumer_id}</span></>
        )}
        {row.environment && <><span>·</span><span>{row.environment}</span></>}
      </div>
      <div className="ep-call-detail-body request-payload-body">
        <PayloadBlock title="Request payload" body={formatPayload(row.request_payload)} />
        <PayloadBlock title="Response payload" body={formatPayload(row.response_payload)} />
      </div>
    </div>
  );
}
