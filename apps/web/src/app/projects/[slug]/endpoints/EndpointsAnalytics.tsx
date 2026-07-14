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
import { cn } from "@/lib/utils";
import {
  Card as ReCard,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/reui/card";
import { Skeleton } from "@/components/reui/skeleton";

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="text-lg font-semibold tracking-tight text-foreground">Analytics</span>
        <span className="text-[13px] text-muted-foreground">Last {rangeLabel} · vs previous {rangeLabel}</span>
      </div>

      {/* KPI strip with period-over-period deltas */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Requests" value={loading ? "—" : fmtNum(cur.total_requests)} cur={cur.total_requests} prev={pre.total_requests} goodWhen="up" />
        <Kpi label="Error rate" value={loading ? "—" : `${cur.error_rate.toFixed(2)}%`} cur={cur.error_rate} prev={pre.error_rate} goodWhen="down" />
        <Kpi label="p95 latency" value={loading ? "—" : fmtMs(cur.p95_response_time_ms)} cur={cur.p95_response_time_ms} prev={pre.p95_response_time_ms} goodWhen="down" />
        <Kpi label="Consumers" value={loading ? "—" : fmtNum(cur.unique_consumers)} cur={cur.unique_consumers} prev={pre.unique_consumers} goodWhen="up" />
        <Kpi label="Endpoints" value={loading ? "—" : fmtNum(cur.unique_endpoints)} cur={cur.unique_endpoints} prev={pre.unique_endpoints} goodWhen="up" />
        <Kpi label="Data" value={loading ? "—" : fmtBytes(dataBytes(cur))} cur={dataBytes(cur)} prev={dataBytes(pre)} goodWhen="neutral" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-card px-3.5 py-3">
      <span className="truncate text-[11px] tracking-[0.04em] uppercase text-muted-foreground">{label}</span>
      <span className="truncate text-xl font-semibold tracking-tight tabular-nums text-foreground">{value}</span>
      <Delta cur={cur} prev={prev} goodWhen={goodWhen} />
    </div>
  );
}

function Delta({ cur, prev, goodWhen }: { cur: number; prev: number; goodWhen: "up" | "down" | "neutral" }) {
  if (cur === prev) return <span className="text-[11px] font-semibold text-muted-foreground">→ no change</span>;
  const up = cur > prev;
  const pct = prev > 0 ? ((cur - prev) / prev) * 100 : 100;
  const dirGood = goodWhen === "neutral" ? null : up === (goodWhen === "up");
  const toneClass =
    dirGood === null ? "text-muted-foreground" : dirGood ? "text-success" : "text-destructive";
  const label = prev === 0 ? "new" : `${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
  return (
    <span className={cn("text-[11px] font-semibold tabular-nums", toneClass)}>
      {up ? "▲" : "▼"} {label} <span className="font-normal text-muted-foreground">vs prev</span>
    </span>
  );
}

function Card({ title, hint, span2, children }: { title: string; hint?: string; span2?: boolean; children: React.ReactNode }) {
  return (
    <ReCard className={cn("min-w-0 gap-3 rounded-xl border-border py-4 shadow-none", span2 && "md:col-span-2")}>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2 space-y-0 px-4">
        <CardTitle className="text-[13px] font-semibold">{title}</CardTitle>
        {hint ? <CardDescription className="text-[11px]">{hint}</CardDescription> : null}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </ReCard>
  );
}

function ChartFrame({ height, loading, empty, children }: { height: number; loading: boolean; empty: boolean; children: React.ReactElement }) {
  if (loading) return <Skeleton className="w-full" style={{ height }} aria-hidden />;
  if (empty) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border text-[13px] text-muted-foreground"
        style={{ height }}
      >
        No data in this period.
      </div>
    );
  }
  return (
    <div style={{ height, width: "100%", minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

function AnTooltip({ active, payload, label, suffix, bytes }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium text-muted-foreground">{label}</p>
      {payload.map((e: any) => (
        <p key={e.dataKey} className="my-0.5" style={{ color: e.color }}>
          {e.name}: {bytes ? fmtBytes(e.value) : `${fmtNum(e.value)}${suffix || ""}`}
        </p>
      ))}
    </div>
  );
}
