"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Summary {
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  unique_endpoints: number;
  unique_consumers: number;
}

interface TSPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
}

interface TopEndpoint {
  method: string;
  path: string;
  total_requests: number;
  error_rate: number;
  appSlug?: string;
}

interface Props {
  projectSlug: string;
  appSlugs: string[];
  environment: string;
  since: string;
  rangeHours: number;
  rangeLabel: string;
  topEndpoints: TopEndpoint[];
  onOpenEndpoint: (e: TopEndpoint) => void;
}

const EMPTY_SUMMARY: Summary = {
  total_requests: 0, error_count: 0, error_rate: 0, avg_response_time_ms: 0,
  p95_response_time_ms: 0, total_request_bytes: 0, total_response_bytes: 0,
  unique_endpoints: 0, unique_consumers: 0,
};

const ACCENT = "#14b8a6";
const WARN = "#f59e0b";
const BAD = "#f87171";
const GRID = "rgba(148,163,184,0.12)";
const AXIS = { fontSize: 10, fill: "var(--text-muted)" } as const;

/* ── Helpers ─────────────────────────────────────────────────────────── */

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}
function fmtMs(n: number): string {
  if (!n || n <= 0) return "0 ms";
  if (n < 1) return `${n.toFixed(2)} ms`;
  return `${Math.round(n)} ms`;
}
function fmtBytes(b: number): string {
  if (!b) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function bucketLabel(b: string, rangeHours: number): string {
  const d = new Date(b);
  if (isNaN(d.getTime())) return b;
  if (rangeHours <= 48) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function dataBytes(s: Summary): number {
  return (s.total_request_bytes || 0) + (s.total_response_bytes || 0);
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function EndpointsAnalytics({
  projectSlug, appSlugs, environment, since, rangeHours, rangeLabel, topEndpoints, onOpenEndpoint,
}: Props) {
  const [now, setNow] = useState<Summary | null>(null);
  const [prev, setPrev] = useState<Summary | null>(null);
  const [series, setSeries] = useState<TSPoint[] | null>(null);

  const windows = useMemo(() => {
    const sinceMs = new Date(since).getTime();
    const dur = rangeHours * 3_600_000;
    const until = new Date().toISOString();
    const prevSince = new Date(sinceMs - dur).toISOString();
    return { since, until, prevSince, prevUntil: since };
  }, [since, rangeHours]);

  useEffect(() => {
    let cancelled = false;
    const q = (s: string, u: string) => {
      const p = new URLSearchParams();
      if (appSlugs.length) p.set("app_slugs", appSlugs.join(","));
      p.set("since", s);
      p.set("until", u);
      if (environment) p.set("environment", environment);
      return p.toString();
    };
    const get = async <T,>(path: string, qs: string, fallback: T): Promise<T> => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/${path}?${qs}`);
        return res.ok ? ((await res.json()) as T) : fallback;
      } catch {
        return fallback;
      }
    };
    (async () => {
      setNow(null); setPrev(null); setSeries(null);
      const [a, b, ts] = await Promise.all([
        get<Summary>("summary", q(windows.since, windows.until), EMPTY_SUMMARY),
        get<Summary>("summary", q(windows.prevSince, windows.prevUntil), EMPTY_SUMMARY),
        get<TSPoint[]>("timeseries", q(windows.since, windows.until), []),
      ]);
      if (cancelled) return;
      setNow(a); setPrev(b); setSeries(Array.isArray(ts) ? ts : []);
    })();
    return () => { cancelled = true; };
  }, [projectSlug, appSlugs, environment, windows]);

  const loading = now === null;
  const cur = now || EMPTY_SUMMARY;
  const pre = prev || EMPTY_SUMMARY;

  const reqData = (series || []).map((p) => ({ label: bucketLabel(p.bucket, rangeHours), requests: p.total_requests, errors: p.error_count }));
  const latData = (series || []).map((p) => ({ label: bucketLabel(p.bucket, rangeHours), p95: Math.round(p.p95_response_time_ms || 0), avg: Math.round(p.avg_response_time_ms || 0) }));
  const errData = (series || []).map((p) => ({ label: bucketLabel(p.bucket, rangeHours), rate: Number((p.error_rate || 0).toFixed(2)) }));
  const dataData = (series || []).map((p) => ({ label: bucketLabel(p.bucket, rangeHours), bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0) }));
  const top = [...topEndpoints].sort((a, b) => b.total_requests - a.total_requests).slice(0, 8).map((e) => ({
    label: `${e.method} ${e.path}`.length > 32 ? `${`${e.method} ${e.path}`.slice(0, 32)}…` : `${e.method} ${e.path}`,
    requests: e.total_requests,
    raw: e,
  }));

  return (
    <div className="ep-an">
      <div className="ep-an-head">
        <span className="ep-an-title">Analytics</span>
        <span className="ep-an-sub">Last {rangeLabel} · vs previous {rangeLabel}</span>
      </div>

      {/* KPI strip with period-over-period deltas */}
      <div className="ep-an-kpis">
        <Kpi label="Requests" value={loading ? "—" : fmtNum(cur.total_requests)} cur={cur.total_requests} prev={pre.total_requests} goodWhen="up" />
        <Kpi label="Error rate" value={loading ? "—" : `${cur.error_rate.toFixed(2)}%`} cur={cur.error_rate} prev={pre.error_rate} goodWhen="down" />
        <Kpi label="p95 latency" value={loading ? "—" : fmtMs(cur.p95_response_time_ms)} cur={cur.p95_response_time_ms} prev={pre.p95_response_time_ms} goodWhen="down" />
        <Kpi label="Consumers" value={loading ? "—" : fmtNum(cur.unique_consumers)} cur={cur.unique_consumers} prev={pre.unique_consumers} goodWhen="up" />
        <Kpi label="Endpoints" value={loading ? "—" : fmtNum(cur.unique_endpoints)} cur={cur.unique_endpoints} prev={pre.unique_endpoints} goodWhen="up" />
        <Kpi label="Data" value={loading ? "—" : fmtBytes(dataBytes(cur))} cur={dataBytes(cur)} prev={dataBytes(pre)} goodWhen="neutral" />
      </div>

      {/* Charts */}
      <div className="ep-an-grid">
        <Card title="Requests over time" hint="Traffic & errors" span2>
          <ChartFrame height={220} loading={loading} empty={reqData.length === 0}>
            <AreaChart data={reqData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="anReq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS} width={42} tickFormatter={fmtCompact} tickLine={false} axisLine={false} />
              <Tooltip content={<AnTooltip />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
              <Area type="monotone" dataKey="requests" name="Requests" stroke={ACCENT} strokeWidth={2} fill="url(#anReq)" />
              <Area type="monotone" dataKey="errors" name="Errors" stroke={BAD} strokeWidth={1.5} fillOpacity={0} />
            </AreaChart>
          </ChartFrame>
        </Card>

        <Card title="Latency over time" hint="avg / p95">
          <ChartFrame height={200} loading={loading} empty={latData.length === 0}>
            <LineChart data={latData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS} width={44} tickFormatter={(v) => `${v}ms`} tickLine={false} axisLine={false} />
              <Tooltip content={<AnTooltip suffix=" ms" />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
              <Line type="monotone" dataKey="avg" name="avg" stroke={ACCENT} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95" name="p95" stroke={WARN} strokeWidth={2} dot={false} />
            </LineChart>
          </ChartFrame>
        </Card>

        <Card title="Top endpoints" hint="by requests">
          <ChartFrame height={Math.max(200, top.length * 26)} loading={loading} empty={top.length === 0}>
            <BarChart data={top} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={AXIS} tickFormatter={fmtCompact} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" width={210} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnTooltip />} cursor={{ fill: "rgba(20,184,166,0.08)" }} />
              <Bar dataKey="requests" name="Requests" fill={ACCENT} radius={[0, 3, 3, 0]} maxBarSize={16}
                onClick={(d: any) => d?.payload?.raw && onOpenEndpoint(d.payload.raw)} cursor="pointer" />
            </BarChart>
          </ChartFrame>
        </Card>

        <Card title="Error rate over time">
          <ChartFrame height={200} loading={loading} empty={errData.length === 0}>
            <AreaChart data={errData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="anErr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BAD} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={BAD} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS} width={42} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
              <Tooltip content={<AnTooltip suffix="%" />} cursor={{ stroke: BAD, strokeDasharray: "3 3" }} />
              <Area type="monotone" dataKey="rate" name="Error rate" stroke={BAD} strokeWidth={2} fill="url(#anErr)" />
            </AreaChart>
          </ChartFrame>
        </Card>

        <Card title="Data transferred over time">
          <ChartFrame height={200} loading={loading} empty={dataData.length === 0}>
            <AreaChart data={dataData} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
              <defs>
                <linearGradient id="anData" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={AXIS} width={56} tickFormatter={fmtBytes} tickLine={false} axisLine={false} />
              <Tooltip content={<AnTooltip bytes />} cursor={{ stroke: ACCENT, strokeDasharray: "3 3" }} />
              <Area type="monotone" dataKey="bytes" name="Transferred" stroke={ACCENT} strokeWidth={2} fill="url(#anData)" />
            </AreaChart>
          </ChartFrame>
        </Card>
      </div>
    </div>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function Kpi({ label, value, cur, prev, goodWhen }: { label: string; value: string; cur: number; prev: number; goodWhen: "up" | "down" | "neutral" }) {
  return (
    <div className="ep-an-kpi">
      <span className="ep-an-kpi-label">{label}</span>
      <span className="ep-an-kpi-value">{value}</span>
      <Delta cur={cur} prev={prev} goodWhen={goodWhen} />
    </div>
  );
}

function Delta({ cur, prev, goodWhen }: { cur: number; prev: number; goodWhen: "up" | "down" | "neutral" }) {
  if (cur === prev) return <span className="ep-an-delta ep-an-delta-flat">→ no change</span>;
  const up = cur > prev;
  const pct = prev > 0 ? ((cur - prev) / prev) * 100 : 100;
  const dirGood = goodWhen === "neutral" ? null : up === (goodWhen === "up");
  const tone = dirGood === null ? "flat" : dirGood ? "good" : "bad";
  const label = prev === 0 ? "new" : `${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
  return <span className={`ep-an-delta ep-an-delta-${tone}`}>{up ? "▲" : "▼"} {label} <span className="ep-an-delta-ctx">vs prev</span></span>;
}

function Card({ title, hint, span2, children }: { title: string; hint?: string; span2?: boolean; children: React.ReactNode }) {
  return (
    <section className={`ep-an-card${span2 ? " ep-an-span2" : ""}`}>
      <div className="ep-an-card-head">
        <span className="ep-an-card-title">{title}</span>
        {hint ? <span className="ep-an-card-hint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ChartFrame({ height, loading, empty, children }: { height: number; loading: boolean; empty: boolean; children: React.ReactElement }) {
  if (loading) return <div className="ep-an-skeleton" style={{ height }} aria-hidden />;
  if (empty) return <div className="ep-an-empty" style={{ height }}>No data in this period.</div>;
  return (
    <div style={{ height, width: "100%", minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

function AnTooltip({ active, payload, label, suffix, bytes }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="ep-an-tip">
      <p className="ep-an-tip-label">{label}</p>
      {payload.map((e: any) => (
        <p key={e.dataKey} style={{ color: e.color }}>
          {e.name}: {bytes ? fmtBytes(e.value) : `${fmtNum(e.value)}${suffix || ""}`}
        </p>
      ))}
    </div>
  );
}
