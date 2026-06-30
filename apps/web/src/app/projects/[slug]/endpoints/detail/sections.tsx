"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Copy, Search, Terminal } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Button,
  Inspector,
  Panel,
  StatusPill,
  statusCodeTone,
} from "@/components/aperture";

/* ── Types ───────────────────────────────────────────────────────────── */

export interface EndpointDetail {
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

export interface TimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  client_errors: number;
  server_errors: number;
  avg_response_time_ms: number;
  p50_response_time_ms: number;
  p95_response_time_ms: number;
  p99_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
}

export interface ConsumerRow {
  consumer: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
}

export interface StatusCodeRow {
  status_code: number;
  total_requests: number;
}

export interface RequestRow {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer: string;
  request_payload?: string;
  response_payload?: string;
  request_headers?: string;
  response_headers?: string;
}

export interface HistogramBucket {
  lower: number;
  upper: number;
  count: number;
}

export interface Histograms {
  response_time: HistogramBucket[];
  response_size: HistogramBucket[];
}

export const STATUS_FILTERS = ["all", "2xx", "3xx", "4xx", "5xx"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/* ── Chart palette ───────────────────────────────────────────────────── */

export const ACCENT = "#14b8a6";
export const CLIENT_ERR = "#f59e0b";
export const SERVER_ERR = "#f87171";
export const P50 = "#38bdf8";
export const P95 = "#fbbf24";
export const P99 = "#f87171";
export const THRESHOLD = "#94a3b8";
export const GRID = "rgba(148, 163, 184, 0.12)";
export const AXIS_TICK = { fontSize: 10, fill: "var(--text-muted)" } as const;

export const EMPTY_DETAIL: EndpointDetail = {
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
export const EMPTY_HISTOGRAMS: Histograms = { response_time: [], response_size: [] };

/* ── Formatters ──────────────────────────────────────────────────────── */

export function formatNumber(n: number): string {
  return Math.round(n || 0).toLocaleString();
}
export function formatMs(n: number): string {
  if (!n) return "0 ms";
  return `${Math.round(n)} ms`;
}
// Histogram-bucket latencies are often sub-millisecond, so rounding to whole ms
// collapses many distinct buckets into a single "0 ms" label. Use adaptive
// precision so adjacent buckets stay distinguishable.
export function formatLatencyBucket(ms: number): string {
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  if (ms > 0) return `${ms.toFixed(2)} ms`;
  return "0 ms";
}
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
export function formatBucketTime(bucket: string): string {
  const d = new Date(bucket);
  if (isNaN(d.getTime())) return bucket;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export function formatBucketFull(bucket: string): string {
  const d = new Date(bucket);
  if (isNaN(d.getTime())) return bucket;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function formatDateTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function timeAgo(ts: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
export function statusTone(status: number): string {
  if (status >= 500) return "endpoint-status-5xx";
  if (status >= 400) return "endpoint-status-4xx";
  if (status >= 300) return "endpoint-status-3xx";
  return "endpoint-status-2xx";
}
export function statusBarClass(status: number): string {
  if (status >= 500) return "is-5xx";
  if (status >= 400) return "is-4xx";
  if (status >= 300) return "is-3xx";
  return "is-2xx";
}

/* ── Shared building blocks ──────────────────────────────────────────── */

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Panel className="endpoint-card" title={title} hint={hint}>
      {children}
    </Panel>
  );
}

export function EmptyBlock({ message }: { message: string }) {
  return <div className="endpoint-detail-empty">{message}</div>;
}

export function ChartBox({ height = 240, children }: { height?: number; children: React.ReactElement }) {
  return (
    <div className="endpoint-chart-frame" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="endpoint-skeleton" style={{ height }} aria-hidden="true" />;
}

export function ChartTooltip({ active, payload, label, valueFormatter }: any) {
  if (!active || !payload || !payload.length) return null;
  const full = payload[0]?.payload?.full;
  return (
    <div className="endpoint-chart-tooltip">
      <p className="endpoint-chart-tooltip-label">{full || label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: {valueFormatter ? valueFormatter(entry.value) : formatNumber(entry.value)}
        </p>
      ))}
    </div>
  );
}

/* ── Info ────────────────────────────────────────────────────────────── */

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ep-info-row">
      <span className="ep-info-key">{label}</span>
      <span className="ep-info-val">{value}</span>
    </div>
  );
}

export function InfoSection({ detail }: { detail: EndpointDetail | null }) {
  if (detail === null) {
    return (
      <Section title="Endpoint info">
        <Skeleton height={200} />
      </Section>
    );
  }
  const lastSeen = detail.last_seen_at
    ? `${formatDateTime(detail.last_seen_at)} (${timeAgo(detail.last_seen_at)})`
    : "Never";
  return (
    <Section title="Endpoint info">
      {detail.description ? <p className="endpoint-page-description">{detail.description}</p> : null}
      <div className="ep-info-grid">
        <InfoRow label="Method" value={detail.method || "—"} />
        <InfoRow label="Path" value={detail.path || "—"} />
        {detail.base_url ? <InfoRow label="Base URL" value={detail.base_url} /> : null}
        <InfoRow label="Last seen" value={lastSeen} />
        <InfoRow label="Total requests" value={formatNumber(detail.total_requests)} />
        <InfoRow label="Requests / min" value={(detail.requests_per_minute || 0).toFixed(2)} />
        <InfoRow label="Error rate" value={`${(detail.error_rate || 0).toFixed(2)}%`} />
        <InfoRow label="p50 / p95 latency" value={`${formatMs(detail.p50_response_time_ms)} / ${formatMs(detail.p95_response_time_ms)}`} />
        <InfoRow label="Apdex" value={detail.apdex ? detail.apdex.toFixed(3) : "—"} />
        {detail.threshold_ms ? <InfoRow label="Apdex threshold" value={formatMs(detail.threshold_ms)} /> : null}
        <InfoRow label="Data transferred" value={formatBytes(detail.total_data_transferred)} />
        <InfoRow label="Avg response size" value={formatBytes(detail.avg_response_size)} />
      </div>
    </Section>
  );
}

/* ── Overview sections ───────────────────────────────────────────────── */

export function TrafficSection({ timeseries }: { timeseries: TimeseriesPoint[] | null }) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    success: Math.max(0, p.total_requests - p.error_count),
    client: p.client_errors,
    server: p.server_errors,
  }));
  const hasData = chartData.some((d) => d.success > 0 || d.client > 0 || d.server > 0);
  return (
    <Section title="Requests over time" hint="Stacked by status class">
      {timeseries === null ? (
        <Skeleton height={240} />
      ) : !hasData ? (
        <EmptyBlock message="No requests in the selected period." />
      ) : (
        <ChartBox height={240}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
            <Bar dataKey="success" name="Success (2xx/3xx)" stackId="t" fill={ACCENT} maxBarSize={44} />
            <Bar dataKey="client" name="Client (4xx)" stackId="t" fill={CLIENT_ERR} maxBarSize={44} />
            <Bar dataKey="server" name="Server (5xx)" stackId="t" fill={SERVER_ERR} radius={[3, 3, 0, 0]} maxBarSize={44} />
          </BarChart>
        </ChartBox>
      )}
    </Section>
  );
}

export function LatencySection({ detail, timeseries }: { detail: EndpointDetail | null; timeseries: TimeseriesPoint[] | null }) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    p50: Math.round(p.p50_response_time_ms || 0),
    p95: Math.round(p.p95_response_time_ms || 0),
    p99: Math.round(p.p99_response_time_ms || 0),
  }));
  const threshold = detail?.threshold_ms || 0;
  return (
    <Section title="Latency over time" hint="Percentiles · p50 / p95 / p99">
      {timeseries === null ? (
        <Skeleton height={240} />
      ) : chartData.length === 0 ? (
        <EmptyBlock message="No requests in the selected period." />
      ) : (
        <ChartBox height={240}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}ms`} />
            <Tooltip content={<ChartTooltip valueFormatter={formatMs} />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
            {threshold > 0 ? (
              <ReferenceLine y={threshold} stroke={THRESHOLD} strokeDasharray="4 4" label={{ value: `threshold ${formatMs(threshold)}`, position: "insideTopRight", fill: "var(--text-muted)", fontSize: 10 }} />
            ) : null}
            <Line type="monotone" dataKey="p50" name="p50" stroke={P50} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="p95" name="p95" stroke={P95} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="p99" name="p99" stroke={P99} strokeWidth={2} dot={false} />
          </LineChart>
        </ChartBox>
      )}
    </Section>
  );
}

export function StatusCodesBlock({ statusCodes }: { statusCodes: StatusCodeRow[] | null }) {
  const codes = (statusCodes || []).slice().sort((a, b) => b.total_requests - a.total_requests);
  const total = codes.reduce((acc, s) => acc + s.total_requests, 0);
  return (
    <Section title="Status codes">
      {statusCodes === null ? (
        <Skeleton height={160} />
      ) : codes.length === 0 ? (
        <EmptyBlock message="No requests in the selected period." />
      ) : (
        <div className="endpoint-status-breakdown">
          {codes.map((s) => {
            const pct = total > 0 ? (s.total_requests / total) * 100 : 0;
            return (
              <div key={s.status_code} className="endpoint-status-row">
                <span className={`endpoint-status-pill ${statusTone(s.status_code)}`}>{s.status_code}</span>
                <div className="endpoint-status-bar-track">
                  <div className={`endpoint-status-bar ${statusBarClass(s.status_code)}`} style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <span className="endpoint-status-count">{formatNumber(s.total_requests)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function LatencyHistogramBlock({ histograms }: { histograms: Histograms | null }) {
  const histData = (histograms?.response_time || []).map((b) => ({
    // Axis label = bucket start; tooltip (`full`) = the bucket's range.
    label: formatLatencyBucket(b.lower),
    full: `${formatLatencyBucket(b.lower)} – ${formatLatencyBucket(b.upper)}`,
    count: b.count,
  }));
  return (
    <Section title="Latency distribution" hint="Requests by response time">
      {histograms === null ? (
        <Skeleton height={160} />
      ) : histData.length === 0 ? (
        <EmptyBlock message="No requests in the selected period." />
      ) : (
        <ChartBox height={200}>
          <BarChart data={histData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-muted)" }} interval="preserveStartEnd" minTickGap={16} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
            <Tooltip content={<ChartTooltip valueFormatter={(v: number) => formatNumber(v)} />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
            <Bar dataKey="count" name="Requests" fill={ACCENT} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ChartBox>
      )}
    </Section>
  );
}

export function ConsumersSection({ projectSlug, consumers }: { projectSlug: string; consumers: ConsumerRow[] | null }) {
  const router = useRouter();
  const consumerData = (consumers || []).map((c) => ({
    label: c.consumer.length > 28 ? `${c.consumer.slice(0, 28)}…` : c.consumer,
    requests: c.total_requests,
    raw: c.consumer,
  }));
  const openConsumer = (consumer: string) => {
    if (!consumer) return;
    router.push(`/projects/${projectSlug}/endpoints?consumer=${encodeURIComponent(consumer)}`);
  };
  return (
    <Section title="Top consumers" hint="Click to see all of a consumer's requests">
      {consumers === null ? (
        <Skeleton height={180} />
      ) : consumerData.length === 0 ? (
        <EmptyBlock message="No consumer data in the selected period." />
      ) : (
        <ChartBox height={Math.max(180, consumerData.length * 36)}>
          <BarChart data={consumerData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={GRID} horizontal={false} />
            <XAxis type="number" tick={AXIS_TICK} allowDecimals={false} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
            <Bar
              dataKey="requests"
              name="Requests"
              fill={ACCENT}
              radius={[0, 3, 3, 0]}
              maxBarSize={22}
              cursor="pointer"
              onClick={(d: { payload?: { raw?: string } }) => d?.payload?.raw && openConsumer(d.payload.raw)}
            />
          </BarChart>
        </ChartBox>
      )}
    </Section>
  );
}

export function DataTransferredSection({
  detail,
  timeseries,
}: {
  detail: EndpointDetail | null;
  timeseries: TimeseriesPoint[] | null;
  histograms?: Histograms | null;
}) {
  const chartData = (timeseries || []).map((p) => ({
    label: formatBucketTime(p.bucket),
    full: formatBucketFull(p.bucket),
    bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0),
  }));
  const hasData = chartData.some((d) => d.bytes > 0);
  return (
    <Section title="Data transferred" hint={detail ? `Total ${formatBytes(detail.total_data_transferred)} · avg ${formatBytes(detail.avg_response_size)}` : undefined}>
      {timeseries === null ? (
        <Skeleton height={200} />
      ) : !hasData ? (
        <EmptyBlock message="No data transferred in the selected period." />
      ) : (
        <ChartBox height={200}>
          <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
            <defs>
              <linearGradient id="dtGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} minTickGap={40} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={AXIS_TICK} tickFormatter={(v) => formatBytes(v)} width={56} tickLine={false} axisLine={false} />
            <Tooltip content={<ChartTooltip valueFormatter={formatBytes} />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
            <Area type="monotone" dataKey="bytes" name="Transferred" stroke={ACCENT} strokeWidth={2} fill="url(#dtGradient)" />
          </AreaChart>
        </ChartBox>
      )}
    </Section>
  );
}

/* ── Requests tab ────────────────────────────────────────────────────── */

export function RequestsTab({ requests, baseUrl }: { requests: RequestRow[] | null; baseUrl: string }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let rows = requests || [];
    if (statusFilter !== "all") {
      const lo = parseInt(statusFilter[0], 10) * 100;
      rows = rows.filter((r) => r.status_code >= lo && r.status_code < lo + 100);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => (r.consumer || "").toLowerCase().includes(q) || String(r.status_code).includes(q));
    }
    return rows;
  }, [requests, statusFilter, search]);

  return (
    <Panel className="endpoint-card">
      <div className="endpoint-requests-toolbar">
        <div className="endpoint-status-filter">
          {STATUS_FILTERS.map((c) => (
            <StatusPill
              key={c}
              interactive
              active={statusFilter === c}
              tone={statusFilter === c ? "accent" : "neutral"}
              onClick={() => setStatusFilter(c)}
            >
              {c === "all" ? "All" : c}
            </StatusPill>
          ))}
        </div>
        <div className="endpoint-requests-search">
          <Search size={13} />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by consumer or status…" />
        </div>
      </div>
      <RequestsTable rows={requests === null ? null : filtered} baseUrl={baseUrl} emptyMessage={requests && requests.length ? "No requests match the filter." : "No logged requests."} />
    </Panel>
  );
}

export function RequestsTable({ rows, baseUrl, emptyMessage }: { rows: RequestRow[] | null; baseUrl: string; emptyMessage: string }) {
  const [selected, setSelected] = useState<RequestRow | null>(null);
  if (!rows) return <Skeleton height={240} />;
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
                <td><span className={`endpoint-status-pill ${statusTone(r.status_code)}`}>{r.status_code}</span></td>
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

/* ── Request payload modal ───────────────────────────────────────────── */

export const CURL_BASE_URL_KEY = "apilens:curl-base-url";

export function buildCurl(row: RequestRow, baseUrl: string): string {
  const base = (baseUrl || "").replace(/\/$/, "") || "YOUR_BASE_URL";
  const body = formatPayload(row.request_payload);
  const lines: string[] = [`curl -X ${row.method} "${base}${row.path}"`];
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join(" \\\n");
}

export function formatPayload(raw: string | undefined): string {
  if (!raw || !raw.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function highlightJson(json: string): string {
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

export function PayloadBlock({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const tooBig = body.length > 40_000;
  const isJson = !!body && !tooBig && (() => { try { JSON.parse(body); return true; } catch { return false; } })();
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
          <pre className="request-payload-pre" dangerouslySetInnerHTML={{ __html: highlightJson(body) }} />
        ) : (
          <pre className="request-payload-pre">{body}</pre>
        )
      ) : (
        <div className="endpoint-detail-empty">No payload captured.</div>
      )}
    </section>
  );
}

export function parseHeaders(raw: string | undefined): [string, string][] {
  if (!raw || !raw.trim()) return [];
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => [k, String(v)] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]));
  } catch {
    return [];
  }
}

export function HeadersBlock({ title, raw }: { title: string; raw: string | undefined }) {
  const headers = parseHeaders(raw);
  if (headers.length === 0) return null;
  return (
    <section className="request-payload-section">
      <div className="request-payload-section-head">
        <h4>{title}</h4>
      </div>
      <div className="ep-headers-list">
        {headers.map(([k, v]) => (
          <div key={k} className="ep-header-row">
            <span className="ep-header-key">{k}</span>
            <span className="ep-header-val">{v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RequestPayloadModal({ row, baseUrl: detectedBaseUrl, onClose }: { row: RequestRow; baseUrl: string; onClose: () => void }) {
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
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Inspector
      width={620}
      onClose={onClose}
      title={
        <>
          <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
          <span className="request-payload-path">{row.path}</span>
          <StatusPill tone={statusCodeTone(row.status_code)}>{row.status_code}</StatusPill>
        </>
      }
      actions={
        <Button variant="secondary" size="sm" onClick={copyCurl} title="Copy as cURL" aria-label="Copy as cURL">
          {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
          {copiedCurl ? "Copied!" : "Copy cURL"}
        </Button>
      }
    >
      <div className="request-payload-meta">
        <span>{formatDateTime(row.timestamp)}</span>
        <span>·</span>
        <span>{formatMs(row.response_time_ms)}</span>
        {row.consumer ? (<><span>·</span><span className="request-payload-meta-consumer">{row.consumer}</span></>) : null}
        {row.environment ? (<><span>·</span><span>{row.environment}</span></>) : null}
      </div>
      <div className="request-payload-body">
        <HeadersBlock title="Request headers" raw={row.request_headers} />
        <PayloadBlock title="Request payload" body={formatPayload(row.request_payload)} />
        <HeadersBlock title="Response headers" raw={row.response_headers} />
        <PayloadBlock title="Response payload" body={formatPayload(row.response_payload)} />
      </div>
    </Inspector>
  );
}
