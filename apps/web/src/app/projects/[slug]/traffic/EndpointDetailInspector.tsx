"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  ArrowUpFromLine,
  Bug,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock,
  Fingerprint,
  Gauge,
  Hash,
  Layers,
  Loader,
  Smile,
  Timer,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACCENT,
  AXIS_TICK,
  CLIENT_ERR,
  ChartTooltip,
  EMPTY_DETAIL,
  EMPTY_HISTOGRAMS,
  EmptyBlock,
  GRID,
  SERVER_ERR,
  Skeleton,
  THRESHOLD,
  formatBytes,
  formatBucketFull,
  formatBucketTime,
  formatLatencyBucket,
  formatMs,
  formatNumber,
  statusTone,
  type ConsumerRow,
  type EndpointDetail,
  type Histograms,
  type RequestRow,
  type StatusCodeRow,
  type TimeseriesPoint,
} from "../endpoints/detail/sections";

/* ── Tabs ────────────────────────────────────────────────────────────── */

type TabKey = "info" | "requests" | "consumers" | "errors" | "response_times" | "data";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "info", label: "Info" },
  { key: "requests", label: "Requests" },
  { key: "consumers", label: "Consumers" },
  { key: "errors", label: "Errors" },
  { key: "response_times", label: "Response times" },
  { key: "data", label: "Data transferred" },
];

/* ── Helpers ─────────────────────────────────────────────────────────── */

function byteLen(s?: string): number {
  if (!s) return 0;
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}
function timeOfDay(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function dayLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function isErrorStatus(code: number): boolean {
  return code >= 400;
}

/* ── Building blocks ─────────────────────────────────────────────────── */

function Pill({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="ep-emodal-pill">
      {icon}
      <span>{children}</span>
    </span>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="ep-section">
      <button type="button" className="ep-section-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronDown size={14} className={`ep-section-chevron${open ? " is-open" : ""}`} />
        <span>{title}</span>
      </button>
      {open && <div className="ep-section-body">{children}</div>}
    </section>
  );
}

type CardTone = "ok" | "warn" | "bad";

function StatCard({
  label,
  icon,
  value,
  sub,
  tone,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  sub?: string;
  tone?: CardTone;
}) {
  return (
    <div className="ep-statcard">
      <div className="ep-statcard-label">{label}</div>
      <div className="ep-statcard-main">
        <span className={`ep-statcard-icon${tone ? ` tone-${tone}` : ""}`}>{icon}</span>
        <span className="ep-statcard-value">{value}</span>
        {sub ? <span className="ep-statcard-sub">{sub}</span> : null}
      </div>
    </div>
  );
}

/* ── Recent requests ─────────────────────────────────────────────────── */

function RecentRequests({
  rows,
  errorsOnly = false,
  onSelect,
}: {
  rows: RequestRow[] | null;
  errorsOnly?: boolean;
  onSelect: (r: RequestRow) => void;
}) {
  if (rows === null) return <Skeleton height={200} />;
  const list = errorsOnly ? rows.filter((r) => isErrorStatus(r.status_code)) : rows;
  if (list.length === 0) {
    return <EmptyBlock message={errorsOnly ? "No client or server errors in the selected period." : "No logged requests."} />;
  }
  return (
    <div className="ep-recent">
      <table className="ep-recent-table">
        <thead>
          <tr>
            <th aria-hidden />
            <th>Time</th>
            <th>Status</th>
            <th>Request</th>
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => {
            const size = byteLen(r.response_payload);
            return (
              <tr
                key={`${r.timestamp}-${i}`}
                className="ep-recent-row"
                onClick={() => onSelect(r)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(r);
                  }
                }}
              >
                <td className="ep-recent-clock"><Clock size={14} /></td>
                <td className="ep-recent-time">
                  <span className="ep-recent-time-h">{timeOfDay(r.timestamp)}</span>
                  <span className="ep-recent-time-d">{dayLabel(r.timestamp)}</span>
                </td>
                <td>
                  <span className={`endpoint-status-pill ${statusTone(r.status_code)}`}>{r.status_code}</span>
                </td>
                <td className="ep-recent-req">
                  <div className="ep-recent-req-line">
                    <span className="ep-recent-method">{r.method}</span>
                    <span className="ep-recent-path">{r.path}</span>
                  </div>
                  <div className="ep-recent-meta">
                    {r.environment ? <span className="ep-recent-fact"><Layers size={12} />{r.environment}</span> : null}
                    {r.consumer ? <span className="ep-recent-fact"><Fingerprint size={12} />{r.consumer}</span> : null}
                    {size > 0 ? <span className="ep-recent-fact"><ArrowUpFromLine size={12} />{formatBytes(size)}</span> : null}
                    <span className="ep-recent-fact"><Timer size={12} />{formatMs(r.response_time_ms)}</span>
                  </div>
                </td>
                <td className="ep-recent-go"><ChevronRight size={15} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Charts ──────────────────────────────────────────────────────────── */

/**
 * Self-measuring chart frame. recharts' ResponsiveContainer initialises its size
 * to -1 and renders blank when it mounts inside an element that wasn't laid out
 * yet — which is exactly what happens inside this portalled, animated modal. So
 * we measure the frame ourselves (ResizeObserver) and hand the chart concrete
 * numeric width/height, the same approach used on the Traffic page.
 */
function Chart({ height, render }: { height: number; render: (width: number) => React.ReactElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="endpoint-chart-frame" style={{ height, width: "100%", minWidth: 0 }}>
      {width > 0 ? render(width) : null}
    </div>
  );
}

function RequestsOverTime({ timeseries }: { timeseries: TimeseriesPoint[] | null }) {
  if (timeseries === null) return <Skeleton height={240} />;
  const data = timeseries.map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    success: Math.max(0, p.total_requests - p.error_count),
    client: p.client_errors,
    server: p.server_errors,
  }));
  if (!data.some((d) => d.success || d.client || d.server)) return <EmptyBlock message="No requests in the selected period." />;
  return (
    <Chart
      height={240}
      render={(w) => (
        <BarChart width={w} height={240} data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
          <Bar dataKey="success" name="Success" stackId="t" fill={ACCENT} maxBarSize={30} />
          <Bar dataKey="client" name="Client (4xx)" stackId="t" fill={CLIENT_ERR} maxBarSize={30} />
          <Bar dataKey="server" name="Server (5xx)" stackId="t" fill={SERVER_ERR} radius={[3, 3, 0, 0]} maxBarSize={30} />
        </BarChart>
      )}
    />
  );
}

function ErrorsOverTime({ timeseries }: { timeseries: TimeseriesPoint[] | null }) {
  if (timeseries === null) return <Skeleton height={220} />;
  const data = timeseries.map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    client: p.client_errors,
    server: p.server_errors,
  }));
  return (
    <Chart
      height={220}
      render={(w) => (
        <BarChart width={w} height={220} data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(248,113,113,0.08)" }} />
          <Bar dataKey="client" name="Client (4xx)" stackId="e" fill={CLIENT_ERR} maxBarSize={30} />
          <Bar dataKey="server" name="Server (5xx)" stackId="e" fill={SERVER_ERR} radius={[3, 3, 0, 0]} maxBarSize={30} />
        </BarChart>
      )}
    />
  );
}

function ResponseTimesOverTime({
  timeseries,
  threshold,
}: {
  timeseries: TimeseriesPoint[] | null;
  threshold: number;
}) {
  if (timeseries === null) return <Skeleton height={240} />;
  // Stacked percentile bands: p50 (solid), p50→p95, p95→p99 (lighter).
  const data = timeseries.map((p) => {
    const p50 = Math.round(p.p50_response_time_ms || 0);
    const p95 = Math.round(p.p95_response_time_ms || 0);
    const p99 = Math.round(p.p99_response_time_ms || 0);
    return {
      label: formatBucketTime(p.bucket),
      full: formatBucketFull(p.bucket),
      p50,
      d95: Math.max(0, p95 - p50),
      d99: Math.max(0, p99 - p95),
    };
  });
  if (data.length === 0) return <EmptyBlock message="No requests in the selected period." />;
  return (
    <Chart
      height={240}
      render={(w) => (
        <AreaChart width={w} height={240} data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} tickFormatter={(v) => `${v} ms`} width={56} tickLine={false} axisLine={false} />
          <Tooltip content={<RtTooltip />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
          {threshold > 0 ? (
            <ReferenceLine y={threshold} stroke={THRESHOLD} strokeDasharray="4 4" label={{ value: "Threshold", position: "insideTopLeft", fill: "var(--text-muted)", fontSize: 10 }} />
          ) : null}
          <Area type="monotone" dataKey="p50" name="p50" stackId="rt" stroke={ACCENT} fill={ACCENT} fillOpacity={0.85} strokeWidth={0} />
          <Area type="monotone" dataKey="d95" name="p95" stackId="rt" stroke={ACCENT} fill={ACCENT} fillOpacity={0.45} strokeWidth={0} />
          <Area type="monotone" dataKey="d99" name="p99" stackId="rt" stroke={ACCENT} fill={ACCENT} fillOpacity={0.2} strokeWidth={0} />
        </AreaChart>
      )}
    />
  );
}

// Tooltip that re-derives the absolute percentile values from the stacked deltas.
function RtTooltip({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const p50 = row.p50;
  const p95 = row.p50 + row.d95;
  const p99 = row.p50 + row.d95 + row.d99;
  return (
    <div className="endpoint-chart-tooltip">
      <p className="endpoint-chart-tooltip-label">{row.full}</p>
      <p style={{ color: ACCENT }}>p50: {formatMs(p50)}</p>
      <p style={{ color: ACCENT }}>p95: {formatMs(p95)}</p>
      <p style={{ color: ACCENT }}>p99: {formatMs(p99)}</p>
    </div>
  );
}

function Histogram({
  buckets,
  unit,
}: {
  buckets: { lower: number; upper: number; count: number }[] | null;
  unit: "ms" | "bytes";
}) {
  if (buckets === null) return <Skeleton height={220} />;
  const fmt = unit === "ms" ? formatLatencyBucket : formatBytes;
  const data = buckets.map((b) => ({
    label: fmt(b.lower),
    full: `${fmt(b.lower)} – ${fmt(b.upper)}`,
    count: b.count,
  }));
  if (data.length === 0) return <EmptyBlock message="No data in the selected period." />;
  return (
    <Chart
      height={220}
      render={(w) => (
        <BarChart width={w} height={220} data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" minTickGap={16} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <Tooltip content={<ChartTooltip valueFormatter={(v: number) => formatNumber(v)} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
          <Bar dataKey="count" name="Requests" fill={ACCENT} radius={[2, 2, 0, 0]} />
        </BarChart>
      )}
    />
  );
}

function DataOverTime({ timeseries }: { timeseries: TimeseriesPoint[] | null }) {
  if (timeseries === null) return <Skeleton height={240} />;
  const data = timeseries.map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0),
  }));
  if (!data.some((d) => d.bytes > 0)) return <EmptyBlock message="No data transferred in the selected period." />;
  return (
    <Chart
      height={240}
      render={(w) => (
        <BarChart width={w} height={240} data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={AXIS_TICK} tickFormatter={(v) => formatBytes(v)} width={56} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip valueFormatter={formatBytes} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
          <Bar dataKey="bytes" name="Transferred" fill={ACCENT} radius={[2, 2, 0, 0]} maxBarSize={30} />
        </BarChart>
      )}
    />
  );
}

function ConsumersTable({ consumers }: { consumers: ConsumerRow[] | null }) {
  if (consumers === null) return <Skeleton height={220} />;
  if (consumers.length === 0) return <EmptyBlock message="No consumer data in the selected period." />;
  const max = Math.max(1, ...consumers.map((c) => c.total_requests));
  return (
    <div className="ep-recent">
      <table className="ep-recent-table ep-consumers-table">
        <thead>
          <tr>
            <th aria-hidden />
            <th>Consumer name</th>
            <th className="ep-th-num">Requests</th>
            <th className="ep-th-num">Error rate</th>
            <th className="ep-th-num">Avg response</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((c) => (
            <tr key={c.consumer}>
              <td className="ep-recent-clock"><Fingerprint size={14} /></td>
              <td className="ep-consumer-name">{c.consumer}</td>
              <td className="ep-td-num">
                <span className="ep-cbar-wrap">
                  <span className="ep-cbar" style={{ width: `${(c.total_requests / max) * 100}%` }} />
                  <span className="ep-cbar-val">{formatNumber(c.total_requests)}</span>
                </span>
              </td>
              <td className={`ep-td-num${(c.error_rate || 0) >= 5 ? " tone-bad" : (c.error_rate || 0) >= 1 ? " tone-warn" : ""}`}>
                {(c.error_rate || 0).toFixed(1)} %
              </td>
              <td className="ep-td-num">{formatMs(c.avg_response_time_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorsByStatus({ statusCodes }: { statusCodes: StatusCodeRow[] | null }) {
  if (statusCodes === null) return <Skeleton height={120} />;
  const codes = statusCodes.filter((s) => isErrorStatus(s.status_code)).sort((a, b) => b.total_requests - a.total_requests);
  if (codes.length === 0) return <EmptyBlock message="No errors in the selected period." />;
  const total = codes.reduce((a, s) => a + s.total_requests, 0);
  return (
    <div className="endpoint-status-breakdown">
      {codes.map((s) => {
        const pct = total > 0 ? (s.total_requests / total) * 100 : 0;
        const cls = s.status_code >= 500 ? "is-5xx" : "is-4xx";
        return (
          <div key={s.status_code} className="endpoint-status-row">
            <span className={`endpoint-status-pill ${statusTone(s.status_code)}`}>{s.status_code}</span>
            <div className="endpoint-status-bar-track">
              <div className={`endpoint-status-bar ${cls}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <span className="endpoint-status-count">{formatNumber(s.total_requests)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Props ───────────────────────────────────────────────────────────── */

interface EndpointDetailInspectorProps {
  projectSlug: string;
  method: string;
  path: string;
  since: string;
  until?: string;
  environment?: string;
  appSlugs?: string[];
  rangeLabel: string;
  onClose: () => void;
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function EndpointDetailInspector({
  projectSlug,
  method,
  path,
  since,
  until,
  environment,
  appSlugs = [],
  rangeLabel,
  onClose,
}: EndpointDetailInspectorProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("requests");

  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[] | null>(null);
  const [consumers, setConsumers] = useState<ConsumerRow[] | null>(null);
  const [statusCodes, setStatusCodes] = useState<StatusCodeRow[] | null>(null);
  const [recentRequests, setRecentRequests] = useState<RequestRow[] | null>(null);
  const [histograms, setHistograms] = useState<Histograms | null>(null);

  const loadingRef = useRef<Set<string>>(new Set());
  const reqIdRef = useRef(0);
  const [, forceRender] = useState(0);

  // Escape closes the modal; lock background scroll while open.
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
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

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
    setTimeseries(null);
    setConsumers(null);
    setStatusCodes(null);
    setRecentRequests(null);
    setHistograms(null);
    loadingRef.current = new Set();
  }, [baseParams]);

  const fetchResource = useCallback(
    async <T,>(key: string, endpointPath: string, setter: (val: T) => void, emptyValue: T, extra?: Record<string, string>) => {
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

    const needTimeseries = activeTab === "requests" || activeTab === "errors" || activeTab === "response_times" || activeTab === "data";
    const needConsumers = activeTab === "requests" || activeTab === "consumers";
    const needStatusCodes = activeTab === "errors";
    const needRequests = activeTab === "requests" || activeTab === "errors";
    const needHistograms = activeTab === "response_times" || activeTab === "data";

    if (needTimeseries && timeseries === null) fetchResource<TimeseriesPoint[]>("timeseries", "endpoint-timeseries", setTimeseries, []);
    if (needConsumers && consumers === null) fetchResource<ConsumerRow[]>("consumers", "endpoint-consumers", setConsumers, [], { limit: "100" });
    if (needStatusCodes && statusCodes === null) fetchResource<StatusCodeRow[]>("status-codes", "endpoint-status-codes", setStatusCodes, []);
    if (needRequests && recentRequests === null) fetchResource<RequestRow[]>("requests", "endpoint-requests", setRecentRequests, [], { limit: "50" });
    if (needHistograms && histograms === null) fetchResource<Histograms>("histograms", "endpoint-histograms", setHistograms, EMPTY_HISTOGRAMS);
  }, [method, path, activeTab, detail, timeseries, consumers, statusCodes, recentRequests, histograms, fetchResource]);

  const d = detail;
  const dl = d === null;
  const threshold = d?.threshold_ms || 0;

  // Clicking a logged request redirects to the Endpoints "Inspect" view with
  // this endpoint's filter applied and the request preselected (matches the
  // Apitally request-logs redirect).
  const openRequest = useCallback(
    (r: RequestRow) => {
      const p = new URLSearchParams();
      p.set("method", method);
      p.set("path", path);
      if (environment) p.set("env", environment);
      if (appSlugs.length) p.set("apps", appSlugs.join(","));
      const end = until ? new Date(until).getTime() : Date.now();
      const hours = Math.round((end - new Date(since).getTime()) / 3_600_000);
      if (hours && hours !== 24) p.set("range", String(hours));
      p.set("req", r.timestamp);
      router.push(`/projects/${projectSlug}/endpoints?${p.toString()}`);
    },
    [router, projectSlug, method, path, environment, appSlugs, since, until],
  );

  const content = (
    <div className="ep-emodal-overlay" onClick={onClose}>
      <div className="ep-emodal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ep-emodal-head">
          <div className="ep-emodal-id">
            <span className="ep-emodal-crumb">Endpoint details</span>
            <ChevronRight size={13} className="ep-emodal-crumb-sep" />
            <span className={`method-badge method-badge-${method.toLowerCase()}`}>{method}</span>
            <span className="ep-emodal-path">{path}</span>
          </div>
          <button type="button" className="ep-emodal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <nav className="ep-emodal-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={activeTab === t.key}
              className={`ep-emodal-tab${activeTab === t.key ? " is-active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="ep-emodal-body">
          <div className="ep-emodal-pills">
            <Pill icon={<Clock size={12} />}>Period = {rangeLabel}</Pill>
            {activeTab === "response_times" && threshold > 0 ? (
              <Pill icon={<Timer size={12} />}>Response time threshold = {formatMs(threshold)}</Pill>
            ) : null}
          </div>

          {activeTab === "info" && (
            <CollapsibleSection title="Summary">
              {dl ? (
                <Skeleton height={60} />
              ) : (
                <div className="ep-info-box">{d!.description || "No description available for this endpoint."}</div>
              )}
            </CollapsibleSection>
          )}

          {activeTab === "requests" && (
            <>
              <CollapsibleSection title="Summary">
                <div className="ep-statcards">
                  <StatCard label="Total requests" icon={<Hash size={16} />} value={dl ? "—" : formatNumber(d!.total_requests)} />
                  <StatCard label="Requests per minute" icon={<Gauge size={16} />} value={dl ? "—" : (d!.requests_per_minute || 0).toFixed(1)} />
                  <StatCard label="Unique consumers" icon={<Fingerprint size={16} />} value={consumers === null ? "—" : formatNumber(consumers.length)} />
                  <StatCard label="Client errors" icon={<CircleX size={16} />} value={dl ? "—" : formatNumber(d!.client_errors)} tone={!dl && d!.client_errors > 0 ? "warn" : undefined} />
                  <StatCard label="Server errors" icon={<Bug size={16} />} value={dl ? "—" : formatNumber(d!.server_errors)} tone={!dl && d!.server_errors > 0 ? "bad" : undefined} />
                </div>
              </CollapsibleSection>
              <CollapsibleSection title="Requests over time">
                <RequestsOverTime timeseries={timeseries} />
              </CollapsibleSection>
              <CollapsibleSection title="Most recent requests">
                <RecentRequests rows={recentRequests} onSelect={openRequest} />
              </CollapsibleSection>
            </>
          )}

          {activeTab === "consumers" && (
            <CollapsibleSection title="Consumers">
              <ConsumersTable consumers={consumers} />
            </CollapsibleSection>
          )}

          {activeTab === "errors" && (
            <>
              <CollapsibleSection title="Errors by status code">
                <ErrorsByStatus statusCodes={statusCodes} />
              </CollapsibleSection>
              <CollapsibleSection title="Client & server errors over time">
                <ErrorsOverTime timeseries={timeseries} />
              </CollapsibleSection>
              <CollapsibleSection title="Most recent client & server errors">
                <RecentRequests rows={recentRequests} errorsOnly onSelect={openRequest} />
              </CollapsibleSection>
            </>
          )}

          {activeTab === "response_times" && (
            <>
              <CollapsibleSection title="Summary">
                <div className="ep-statcards">
                  <StatCard label="Apdex score" icon={<Smile size={16} />} value={dl ? "—" : (d!.apdex || 0).toFixed(3)} tone={!dl ? (d!.apdex >= 0.94 ? "ok" : d!.apdex >= 0.85 ? "warn" : "bad") : undefined} />
                  <StatCard label="Slow requests" icon={<Loader size={16} />} value={dl ? "—" : formatNumber(d!.slow_requests)} sub={dl ? undefined : `of ${formatNumber(d!.total_requests)}`} />
                  <StatCard label="50th percentile" icon={<Timer size={16} />} value={dl ? "—" : formatMs(d!.p50_response_time_ms)} />
                  <StatCard label="75th percentile" icon={<Timer size={16} />} value={dl ? "—" : formatMs(d!.p75_response_time_ms)} />
                  <StatCard label="95th percentile" icon={<Timer size={16} />} value={dl ? "—" : formatMs(d!.p95_response_time_ms)} />
                </div>
              </CollapsibleSection>
              <CollapsibleSection title="Response times over time">
                <ResponseTimesOverTime timeseries={timeseries} threshold={threshold} />
              </CollapsibleSection>
              <CollapsibleSection title="Histogram of response times">
                <Histogram buckets={histograms ? histograms.response_time : null} unit="ms" />
              </CollapsibleSection>
            </>
          )}

          {activeTab === "data" && (
            <>
              <CollapsibleSection title="Summary">
                <div className="ep-statcards">
                  <StatCard label="Total data transferred" icon={<ArrowLeftRight size={16} />} value={dl ? "—" : formatBytes(d!.total_data_transferred)} />
                  <StatCard label="Average response size" icon={<ArrowUpFromLine size={16} />} value={dl ? "—" : formatBytes(d!.avg_response_size)} />
                </div>
              </CollapsibleSection>
              <CollapsibleSection title="Data transferred over time">
                <DataOverTime timeseries={timeseries} />
              </CollapsibleSection>
              <CollapsibleSection title="Histogram of response sizes">
                <Histogram buckets={histograms ? histograms.response_size : null} unit="bytes" />
              </CollapsibleSection>
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
