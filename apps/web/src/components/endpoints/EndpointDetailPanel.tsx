"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, GripVertical, Maximize2, Minimize2, Terminal, X } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface EndpointDetailTarget {
  method: string;
  path: string;
}

interface EndpointDetailPanelProps {
  projectSlug: string;
  endpoint: EndpointDetailTarget;
  appSlugs: string[];
  environment: string;
  since: string;
  until?: string;
  rangeLabel: string;
  onClose: () => void;
}

type TabKey = "requests" | "errors" | "response-times" | "data-transferred";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "requests", label: "Requests" },
  { key: "errors", label: "Errors" },
  { key: "response-times", label: "Response times" },
  { key: "data-transferred", label: "Data transferred" },
];

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

interface TimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  client_errors: number;
  server_errors: number;
  avg_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
}

interface ConsumerRow {
  consumer: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
}

interface StatusCodeRow {
  status_code: number;
  total_requests: number;
}

interface RequestRow {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer: string;
  request_payload?: string;
  response_payload?: string;
}

interface HistogramBucket {
  lower: number;
  upper: number;
  count: number;
}

interface Histograms {
  response_time: HistogramBucket[];
  response_size: HistogramBucket[];
}

const ACCENT = "#14b8a6";
const CLIENT_ERR = "#f59e0b";
const SERVER_ERR = "#f87171";
const GRID = "rgba(148, 163, 184, 0.12)";
const AXIS_TICK = { fontSize: 10, fill: "var(--text-muted)" } as const;

const PANEL_MIN_WIDTH = 460;
const PANEL_DEFAULT_WIDTH = 720;
const PANEL_WIDTH_KEY = "apilens:endpoint-panel-width";

function panelMaxWidth(): number {
  if (typeof window === "undefined") return 1600;
  return Math.round(window.innerWidth * 0.95);
}

// Fallback used when a detail request fails, so the panel degrades to an empty
// state instead of a stuck skeleton.
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
const EMPTY_HISTOGRAMS: Histograms = { response_time: [], response_size: [] };

function formatNumber(n: number): string {
  return Math.round(n || 0).toLocaleString();
}

function formatMs(n: number): string {
  if (!n) return "0 ms";
  return `${Math.round(n)} ms`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBucketTime(bucket: string): string {
  const d = new Date(bucket);
  if (isNaN(d.getTime())) return bucket;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusTone(status: number): string {
  if (status >= 500) return "endpoint-status-5xx";
  if (status >= 400) return "endpoint-status-4xx";
  if (status >= 300) return "endpoint-status-3xx";
  return "endpoint-status-2xx";
}

export default function EndpointDetailPanel({
  projectSlug,
  endpoint,
  appSlugs,
  environment,
  since,
  until,
  rangeLabel,
  onClose,
}: EndpointDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("requests");

  // Resizable / expandable drawer width (persisted across opens).
  const [panelWidth, setPanelWidth] = useState<number>(PANEL_DEFAULT_WIDTH);
  const [expanded, setExpanded] = useState(false);
  const draggingRef = useRef(false);
  const widthRef = useRef(PANEL_DEFAULT_WIDTH);
  widthRef.current = panelWidth;

  // Restore the saved width once mounted (avoids SSR/localStorage mismatch).
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (saved && saved >= PANEL_MIN_WIDTH) {
      setPanelWidth(Math.min(saved, panelMaxWidth()));
    }
  }, []);

  // Drag-to-resize from the left edge.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = Math.min(panelMaxWidth(), Math.max(PANEL_MIN_WIDTH, window.innerWidth - e.clientX));
      setExpanded(false);
      setPanelWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(widthRef.current)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  const resetWidth = useCallback(() => {
    setExpanded(false);
    setPanelWidth(PANEL_DEFAULT_WIDTH);
    window.localStorage.setItem(PANEL_WIDTH_KEY, String(PANEL_DEFAULT_WIDTH));
  }, []);

  const panelStyleWidth = expanded ? "95vw" : `${panelWidth}px`;

  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[] | null>(null);
  const [consumers, setConsumers] = useState<ConsumerRow[] | null>(null);
  const [statusCodes, setStatusCodes] = useState<StatusCodeRow[] | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestRow[] | null>(null);
  const [errorRequests, setErrorRequests] = useState<RequestRow[] | null>(null);
  const [histograms, setHistograms] = useState<Histograms | null>(null);

  const loadingRef = useRef<Set<string>>(new Set());
  // Bumped on every endpoint/filter change so in-flight responses from a prior
  // selection can be detected and discarded (prevents stale data overwrites).
  const reqIdRef = useRef(0);
  const [, forceRender] = useState(0);

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("method", endpoint.method);
    params.set("path", endpoint.path);
    if (appSlugs.length) params.set("app_slugs", appSlugs.join(","));
    params.set("since", since);
    if (until) params.set("until", until);
    if (environment) params.set("environment", environment);
    return params;
  }, [endpoint.method, endpoint.path, appSlugs, since, until, environment]);

  // Reset all cached data whenever the endpoint or filters change.
  useEffect(() => {
    reqIdRef.current += 1;
    setDetail(null);
    setTimeseries(null);
    setConsumers(null);
    setStatusCodes(null);
    setRecentRequests(null);
    setErrorRequests(null);
    setHistograms(null);
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
        if (extra) {
          for (const [k, v] of Object.entries(extra)) params.set(k, v);
        }
        const res = await fetch(
          `/api/projects/${projectSlug}/analytics/${endpointPath}?${params.toString()}`,
        );
        // Discard responses superseded by a newer endpoint/filter selection.
        if (reqId !== reqIdRef.current) return;
        setter(res.ok ? ((await res.json()) as T) : emptyValue);
      } catch {
        // Surface an empty state (not a stuck skeleton) on transient failures.
        if (reqId === reqIdRef.current) setter(emptyValue);
      } finally {
        // Always clear the key so a later dep change can retry this resource.
        loadingRef.current.delete(key);
        forceRender((n) => n + 1);
      }
    },
    [baseParams, projectSlug],
  );

  // Load the data each active tab needs (shared resources are cached).
  useEffect(() => {
    if (detail === null) {
      fetchResource<EndpointDetail>("detail", "endpoint-detail", setDetail, EMPTY_DETAIL);
    }
    if (activeTab === "requests") {
      if (timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
      if (consumers === null) fetchResource<ConsumerRow[]>("consumers", "endpoint-consumers", setConsumers, [], { limit: "8" });
      if (recentRequests === null) fetchResource<RequestRow[]>("requests", "endpoint-requests", setRecentRequests, [], { limit: "10" });
    } else if (activeTab === "errors") {
      if (timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
      if (statusCodes === null) fetchResource<StatusCodeRow[]>("status-codes", "endpoint-status-codes", setStatusCodes, []);
      if (errorRequests === null) fetchResource<RequestRow[]>("error-requests", "endpoint-requests", setErrorRequests, [], { limit: "10", errors_only: "true" });
    } else if (activeTab === "response-times") {
      if (timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
      if (histograms === null) fetchResource<Histograms>("histograms", "endpoint-histograms", setHistograms, EMPTY_HISTOGRAMS);
    } else if (activeTab === "data-transferred") {
      if (timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
      if (histograms === null) fetchResource<Histograms>("histograms", "endpoint-histograms", setHistograms, EMPTY_HISTOGRAMS);
    }
  }, [activeTab, detail, timeseries, consumers, statusCodes, recentRequests, errorRequests, histograms, fetchResource]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock background scroll while the drawer is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const isLoading = (key: string) => loadingRef.current.has(key) &&
    ((key === "detail" && detail === null) ||
      (key === "timeseries" && timeseries === null) ||
      (key === "consumers" && consumers === null) ||
      (key === "status-codes" && statusCodes === null) ||
      (key === "requests" && recentRequests === null) ||
      (key === "error-requests" && errorRequests === null) ||
      (key === "histograms" && histograms === null));

  const overlay = (
    <div className="endpoint-detail-overlay" onClick={onClose}>
      <aside
        className="endpoint-detail-panel"
        style={{ width: panelStyleWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="endpoint-detail-resizer"
          onMouseDown={startResize}
          onDoubleClick={resetWidth}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel (double-click to reset)"
          title="Drag to resize · double-click to reset"
        >
          <span className="endpoint-detail-resizer-grip">
            <GripVertical size={14} />
          </span>
        </div>
        <header className="endpoint-detail-header">
          <div className="endpoint-detail-breadcrumb">
            <span>Endpoint details</span>
          </div>
          <div className="endpoint-detail-header-actions">
            <button
              type="button"
              className="endpoint-detail-close"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Restore panel width" : "Expand panel"}
              title={expanded ? "Restore width" : "Expand"}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" className="endpoint-detail-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="endpoint-detail-title">
          <span className={`method-badge method-badge-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <span className="endpoint-detail-path">{endpoint.path}</span>
        </div>

        <nav className="endpoint-detail-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`endpoint-detail-tab${activeTab === tab.key ? " active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="endpoint-detail-period">
          <span className="endpoint-detail-period-chip">Period · {rangeLabel}{environment ? ` · ${environment}` : ""}</span>
        </div>

        <div className="endpoint-detail-body">
          {activeTab === "requests" && (
            <RequestsTab
              detail={detail}
              timeseries={timeseries}
              consumers={consumers}
              requests={recentRequests}
              baseUrl={detail?.base_url || ""}
            />
          )}
          {activeTab === "errors" && (
            <ErrorsTab timeseries={timeseries} statusCodes={statusCodes} errorRequests={errorRequests} baseUrl={detail?.base_url || ""} />
          )}
          {activeTab === "response-times" && (
            <ResponseTimesTab detail={detail} timeseries={timeseries} histograms={histograms} />
          )}
          {activeTab === "data-transferred" && (
            <DataTransferredTab detail={detail} timeseries={timeseries} histograms={histograms} />
          )}
        </div>
      </aside>
    </div>
  );

  // Portal to <body> so no transformed/stacking ancestor can offset or clip the
  // drawer — guarantees it spans the full viewport height from the very top.
  if (typeof document === "undefined") return null;
  return createPortal(overlay, document.body);
}

/* ── Shared building blocks ──────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="endpoint-detail-section">
      <h4 className="endpoint-detail-section-title">{title}</h4>
      {children}
    </section>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="endpoint-stat-card">
      <p className="endpoint-stat-label">{label}</p>
      <p className={`endpoint-stat-value${tone ? ` ${tone}` : ""}`}>{value}</p>
    </div>
  );
}

function EmptyBlock({ message }: { message: string }) {
  return <div className="endpoint-detail-empty">{message}</div>;
}

/**
 * Fixed-height frame for recharts. recharts 3's ResponsiveContainer collapses
 * to 0×0 when its parent has no resolved height (common inside flex/animated
 * panels), so we pin an explicit height here and let it fill 100% — this is
 * what stops charts from rendering blank.
 */
function ChartBox({ height = 220, children }: { height?: number; children: React.ReactElement }) {
  return (
    <div className="endpoint-chart-frame" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="endpoint-skeleton" style={{ height }} aria-hidden="true" />;
}

function ChartTooltip({ active, payload, label, valueFormatter }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="endpoint-chart-tooltip">
      <p className="endpoint-chart-tooltip-label">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: {valueFormatter ? valueFormatter(entry.value) : formatNumber(entry.value)}
        </p>
      ))}
    </div>
  );
}

/* ── Info tab ────────────────────────────────────────────────────────── */

function InfoTab({ detail, loading }: { detail: EndpointDetail | null; loading: boolean }) {
  if (loading && !detail) return <Skeleton height={72} />;
  return (
    <Section title="Summary">
      <div className="endpoint-detail-summary-box">
        {detail?.description ? detail.description : <span className="endpoint-detail-muted">No description provided for this endpoint.</span>}
      </div>
    </Section>
  );
}

/* ── Requests tab ────────────────────────────────────────────────────── */

function RequestsTab({
  detail,
  timeseries,
  consumers,
  requests,
  baseUrl,
}: {
  detail: EndpointDetail | null;
  timeseries: TimeseriesPoint[] | null;
  consumers: ConsumerRow[] | null;
  requests: RequestRow[] | null;
  baseUrl: string;
}) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    requests: p.total_requests,
  }));
  const consumerData = (consumers || []).map((c) => ({
    label: c.consumer.length > 28 ? `${c.consumer.slice(0, 28)}…` : c.consumer,
    requests: c.total_requests,
  }));

  return (
    <>
      <Section title="Summary">
        <div className="endpoint-stat-grid">
          <StatCard label="Total requests" value={formatNumber(detail?.total_requests || 0)} />
          <StatCard label="Requests per minute" value={(detail?.requests_per_minute || 0).toFixed(2)} />
          <StatCard label="Successful requests" value={formatNumber(detail?.successful_requests || 0)} tone="tone-good" />
          <StatCard label="Client errors" value={formatNumber(detail?.client_errors || 0)} tone={detail?.client_errors ? "tone-warn" : undefined} />
          <StatCard label="Server errors" value={formatNumber(detail?.server_errors || 0)} tone={detail?.server_errors ? "tone-bad" : undefined} />
        </div>
      </Section>

      <Section title="Requests over time">
        {timeseries === null ? (
          <Skeleton height={220} />
        ) : chartData.length === 0 ? (
          <EmptyBlock message="No requests in the selected period." />
        ) : (
          <ChartBox height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="requests" name="Requests" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ChartBox>
        )}
      </Section>

      <Section title="Requests per consumer">
        {consumers === null ? (
          <Skeleton height={180} />
        ) : consumerData.length === 0 ? (
          <EmptyBlock message="No consumer data in the selected period." />
        ) : (
          <ChartBox height={Math.max(150, consumerData.length * 36)}>
            <BarChart data={consumerData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="requests" name="Requests" fill={ACCENT} radius={[0, 3, 3, 0]} maxBarSize={22} />
            </BarChart>
          </ChartBox>
        )}
      </Section>

      <Section title="Most recent requests">
        <RequestsTable rows={requests} baseUrl={baseUrl} emptyMessage="No logged requests." />
      </Section>
    </>
  );
}

function RequestsTable({ rows, baseUrl, emptyMessage }: { rows: RequestRow[] | null; baseUrl: string; emptyMessage: string }) {
  const [selected, setSelected] = useState<RequestRow | null>(null);

  if (!rows) return <Skeleton height={140} />;
  if (rows.length === 0) return <EmptyBlock message={emptyMessage} />;
  return (
    <>
      <div className="endpoint-detail-table-wrapper">
        <table className="endpoint-detail-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Consumer</th>
              <th>Response</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.timestamp}-${i}`}
                className="request-row-clickable"
                onClick={() => setSelected(r)}
                tabIndex={0}
                role="button"
                aria-label="View request and response payload"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(r);
                  }
                }}
              >
                <td className="endpoint-detail-time">{formatDateTime(r.timestamp)}</td>
                <td>
                  <span className={`endpoint-status-pill ${statusTone(r.status_code)}`}>{r.status_code}</span>
                </td>
                <td className="endpoint-detail-consumer">{r.consumer || "—"}</td>
                <td className="endpoint-detail-time">{formatMs(r.response_time_ms)}</td>
                <td className="request-row-chevron"><ChevronRight size={14} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && <RequestPayloadModal row={selected} baseUrl={baseUrl} onClose={() => setSelected(null)} />}
    </>
  );
}

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
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    } catch {
      // Clipboard unavailable (e.g. insecure context) — silently ignore.
    }
  };
  const isJson = !!body && (() => { try { JSON.parse(body); return true; } catch { return false; } })();
  return (
    <section className="request-payload-section">
      <div className="request-payload-section-head">
        <h4>{title}</h4>
        {body ? (
          <button type="button" className="request-payload-copy" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      {body ? (
        isJson ? (
          <pre
            className="request-payload-pre"
            dangerouslySetInnerHTML={{ __html: highlightJson(body) }}
          />
        ) : (
          <pre className="request-payload-pre">{body}</pre>
        )
      ) : (
        <div className="endpoint-detail-empty">No payload captured.</div>
      )}
    </section>
  );
}

function RequestPayloadModal({ row, baseUrl: detectedBaseUrl, onClose }: { row: RequestRow; baseUrl: string; onClose: () => void }) {
  const [copiedCurl, setCopiedCurl] = useState(false);
  // Seed from the SDK-detected URL; let user override and persist the override.
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window === "undefined") return detectedBaseUrl;
    return localStorage.getItem(CURL_BASE_URL_KEY) || detectedBaseUrl;
  });

  // If a fresh detection arrives (different panel open) and user has no override, adopt it.
  useEffect(() => {
    if (detectedBaseUrl && !localStorage.getItem(CURL_BASE_URL_KEY)) {
      setBaseUrl(detectedBaseUrl);
    }
  }, [detectedBaseUrl]);

  const handleBaseUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setBaseUrl(val);
    if (val) {
      localStorage.setItem(CURL_BASE_URL_KEY, val);
    } else {
      localStorage.removeItem(CURL_BASE_URL_KEY);
    }
  };

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(row, baseUrl));
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };

  // Close on Escape; capture-phase + stopPropagation so it closes this popup
  // only (not the underlying drawer, which also listens for Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const content = (
    <div className="request-payload-overlay" onClick={onClose}>
      <div className="request-payload-modal" onClick={(e) => e.stopPropagation()}>
        <header className="request-payload-header">
          <div className="request-payload-title">
            <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
            <span className="request-payload-path">{row.path}</span>
            <span className={`endpoint-status-pill ${statusTone(row.status_code)}`}>{row.status_code}</span>
          </div>
          <div className="request-payload-header-actions">
            <button
              type="button"
              className="request-payload-copy"
              onClick={copyCurl}
              title="Copy as cURL"
              aria-label="Copy as cURL"
            >
              {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
              {copiedCurl ? "Copied!" : "Copy cURL"}
            </button>
            <button type="button" className="endpoint-detail-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="request-payload-meta">
          <span>{formatDateTime(row.timestamp)}</span>
          <span>·</span>
          <span>{formatMs(row.response_time_ms)}</span>
          {row.consumer ? (
            <>
              <span>·</span>
              <span className="request-payload-meta-consumer">{row.consumer}</span>
            </>
          ) : null}
          {row.environment ? (
            <>
              <span>·</span>
              <span>{row.environment}</span>
            </>
          ) : null}
        </div>
        <div className="request-payload-body">
          <PayloadBlock title="Request payload" body={formatPayload(row.request_payload)} />
          <PayloadBlock title="Response payload" body={formatPayload(row.response_payload)} />
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}

/* ── Errors tab ──────────────────────────────────────────────────────── */

function ErrorsTab({
  timeseries,
  statusCodes,
  errorRequests,
  baseUrl,
}: {
  timeseries: TimeseriesPoint[] | null;
  statusCodes: StatusCodeRow[] | null;
  errorRequests: RequestRow[] | null;
  baseUrl: string;
}) {
  const errorCodes = (statusCodes || []).filter((s) => s.status_code >= 400);
  const totalErrors = errorCodes.reduce((acc, s) => acc + s.total_requests, 0);
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    client: p.client_errors,
    server: p.server_errors,
  }));
  const hasErrorsOverTime = chartData.some((d) => d.client > 0 || d.server > 0);

  return (
    <>
      <Section title="Errors by status code">
        {statusCodes === null ? (
          <Skeleton height={120} />
        ) : errorCodes.length === 0 ? (
          <EmptyBlock message="No errors in the selected period." />
        ) : (
          <div className="endpoint-status-breakdown">
            {errorCodes.map((s) => {
              const pct = totalErrors > 0 ? (s.total_requests / totalErrors) * 100 : 0;
              return (
                <div key={s.status_code} className="endpoint-status-row">
                  <span className={`endpoint-status-pill ${statusTone(s.status_code)}`}>{s.status_code}</span>
                  <div className="endpoint-status-bar-track">
                    <div
                      className={`endpoint-status-bar ${s.status_code >= 500 ? "is-server" : "is-client"}`}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  <span className="endpoint-status-count">{formatNumber(s.total_requests)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Client & server errors over time">
        {timeseries === null ? (
          <Skeleton height={220} />
        ) : !hasErrorsOverTime ? (
          <EmptyBlock message="No errors in the selected period." />
        ) : (
          <ChartBox height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(248,113,113,0.08)" }} />
              <Bar dataKey="client" name="Client (4xx)" stackId="e" fill={CLIENT_ERR} radius={[0, 0, 0, 0]} maxBarSize={40} />
              <Bar dataKey="server" name="Server (5xx)" stackId="e" fill={SERVER_ERR} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ChartBox>
        )}
      </Section>

      <Section title="Most recent client & server errors">
        <RequestsTable rows={errorRequests} baseUrl={baseUrl} emptyMessage="No logged requests." />
      </Section>
    </>
  );
}

/* ── Response times tab ──────────────────────────────────────────────── */

function ResponseTimesTab({
  detail,
  timeseries,
  histograms,
}: {
  detail: EndpointDetail | null;
  timeseries: TimeseriesPoint[] | null;
  histograms: Histograms | null;
}) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    avg: Math.round(p.avg_response_time_ms),
  }));
  const histData = (histograms?.response_time || []).map((b) => ({
    label: `${Math.round(b.lower)} ms`,
    count: b.count,
  }));

  return (
    <>
      <Section title="Summary">
        <div className="endpoint-stat-grid">
          <StatCard label="Apdex score" value={(detail?.apdex || 0).toFixed(3)} />
          <StatCard
            label="Slow requests"
            value={formatNumber(detail?.slow_requests || 0)}
            tone={detail?.slow_requests ? "tone-warn" : undefined}
          />
          <StatCard label="50th percentile" value={formatMs(detail?.p50_response_time_ms || 0)} />
          <StatCard label="75th percentile" value={formatMs(detail?.p75_response_time_ms || 0)} />
          <StatCard label="95th percentile" value={formatMs(detail?.p95_response_time_ms || 0)} />
        </div>
        {detail ? (
          <p className="endpoint-detail-note">Response time threshold = {formatMs(detail.threshold_ms)}</p>
        ) : null}
      </Section>

      <Section title="Response times over time">
        {timeseries === null ? (
          <Skeleton height={220} />
        ) : chartData.length === 0 ? (
          <EmptyBlock message="No requests in the selected period." />
        ) : (
          <ChartBox height={220}>
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="rtGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}`} />
              <Tooltip content={<ChartTooltip valueFormatter={formatMs} />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
              <Area type="monotone" dataKey="avg" name="Avg response" stroke={ACCENT} strokeWidth={2} fill="url(#rtGradient)" />
            </AreaChart>
          </ChartBox>
        )}
      </Section>

      <Section title="Histogram of response times">
        {histograms === null ? (
          <Skeleton height={200} />
        ) : histData.length === 0 ? (
          <EmptyBlock message="No requests in the selected period." />
        ) : (
          <ChartBox height={200}>
            <BarChart data={histData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <Tooltip content={<ChartTooltip valueFormatter={(v: number) => formatNumber(v)} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="count" name="Requests" fill={ACCENT} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartBox>
        )}
      </Section>
    </>
  );
}

/* ── Data transferred tab ────────────────────────────────────────────── */

function DataTransferredTab({
  detail,
  timeseries,
  histograms,
}: {
  detail: EndpointDetail | null;
  timeseries: TimeseriesPoint[] | null;
  histograms: Histograms | null;
}) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0),
  }));
  const hasData = chartData.some((d) => d.bytes > 0);
  const histData = (histograms?.response_size || []).map((b) => ({
    label: formatBytes(b.lower),
    count: b.count,
  }));

  return (
    <>
      <Section title="Summary">
        <div className="endpoint-stat-grid">
          <StatCard label="Total data transferred" value={formatBytes(detail?.total_data_transferred || 0)} />
          <StatCard label="Average response size" value={formatBytes(detail?.avg_response_size || 0)} />
        </div>
      </Section>

      <Section title="Data transferred over time">
        {timeseries === null ? (
          <Skeleton height={220} />
        ) : !hasData ? (
          <EmptyBlock message="No data transferred in the selected period." />
        ) : (
          <ChartBox height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} tickFormatter={(v) => formatBytes(v)} width={56} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip valueFormatter={formatBytes} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="bytes" name="Transferred" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ChartBox>
        )}
      </Section>

      <Section title="Histogram of response sizes">
        {histograms === null ? (
          <Skeleton height={200} />
        ) : histData.length === 0 ? (
          <EmptyBlock message="No requests in the selected period." />
        ) : (
          <ChartBox height={200}>
            <BarChart data={histData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <Tooltip content={<ChartTooltip valueFormatter={(v: number) => formatNumber(v)} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="count" name="Requests" fill={ACCENT} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartBox>
        )}
      </Section>
    </>
  );
}
