"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Check, ChevronDown, ChevronRight, MoreVertical, RefreshCw, Search, X } from "lucide-react";
import {
  type RangeValue,
  DEFAULT_PRESET_ID,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import EndpointDetailInspector from "./EndpointDetailInspector";

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
  total_request_bytes: number;
  total_response_bytes: number;
}

type MetricKey = "requests" | "rpm" | "errors" | "data";

interface EndpointStat {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  total_request_bytes?: number;
  total_response_bytes?: number;
}

type AppOption = { id: string; name: string; slug: string };
type SortKey = "total_requests" | "error_rate" | "data";

// Filters seeded from the URL query (read server-side in page.tsx) so a refresh
// or shared link restores the exact view.
interface InitialFilters {
  range?: string;
  since?: string;
  until?: string;
  apps?: string;
  env?: string;
  metric?: string;
  sort?: string;
  consumer?: string;
}

interface Props {
  projectSlug: string;
  initialFilters?: InitialFilters;
}

const EMPTY_SUMMARY: Summary = {
  total_requests: 0, error_count: 0, error_rate: 0, avg_response_time_ms: 0,
  p95_response_time_ms: 0, total_request_bytes: 0, total_response_bytes: 0,
  unique_endpoints: 0, unique_consumers: 0,
};

// Chart palette — tuned to sit with the teal Aperture theme instead of the
// neon green/red defaults, which read "too sharp" on the dark surfaces.
const ACCENT = "#14b8a6";
const GREEN = "#10b981"; // emerald — harmonises with the teal accent
const RED = "#f87171"; // soft red — matches the "bad" text tone elsewhere
const GRID = "rgba(148,163,184,0.12)";
const AXIS = { fontSize: 10, fill: "var(--text-muted)" } as const;
// Static bar heights (%) for the chart loading skeleton.
const SKELETON_BARS = [58, 80, 46, 88, 62, 74, 52, 90, 66, 78, 48, 84];

/* ── Helpers ─────────────────────────────────────────────────────────── */

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
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
// Richer label for the tooltip header (the axis ticks stay terse).
function bucketTipLabel(b: string, rangeHours: number): string {
  const d = new Date(b);
  if (isNaN(d.getTime())) return String(b);
  if (rangeHours <= 48) {
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function dataBytes(s: { total_request_bytes?: number; total_response_bytes?: number }): number {
  return (s.total_request_bytes || 0) + (s.total_response_bytes || 0);
}
function methodColor(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "ep-method-get";
  if (k === "POST") return "ep-method-post";
  if (k === "PUT") return "ep-method-put";
  if (k === "PATCH") return "ep-method-patch";
  if (k === "DELETE") return "ep-method-delete";
  return "ep-method-other";
}
function errToneClass(errRate: number): string {
  if (errRate >= 5) return "tf-err-bad";
  if (errRate >= 1) return "tf-err-warn";
  return "";
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function TrafficContent({ projectSlug, initialFilters }: Props) {
  const [apps, setApps] = useState<AppOption[]>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(initialFilters?.env || "");

  const [rangeValue, setRangeValue] = useState<RangeValue>(() => parseRange(initialFilters));
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    initialFilters?.sort === "error_rate" || initialFilters?.sort === "data"
      ? initialFilters.sort
      : "total_requests"
  );
  const [activeMetric, setActiveMetric] = useState<MetricKey>(() =>
    initialFilters?.metric === "rpm" || initialFilters?.metric === "errors" || initialFilters?.metric === "data"
      ? initialFilters.metric
      : "requests"
  );
  const [refreshKey, setRefreshKey] = useState(0);

  // Endpoint table: client-side search, the open detail slide-over, and the
  // per-row kebab menu (keyed by `${method}-${path}`).
  const [endpointSearch, setEndpointSearch] = useState("");
  const [openRow, setOpenRow] = useState<EndpointStat | null>(null);
  const [kebabRow, setKebabRow] = useState<string | null>(null);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<TSPoint[] | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointStat[]>([]);
  const [loading, setLoading] = useState(true);

  // Recharts logs "width(-1)/height(-1)" if its ResponsiveContainer mounts
  // before the stage has a measured size. Mount the chart only once we've
  // observed a positive width; the skeleton overlay covers this first frame.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setStageWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-resolve when the range changes or on refresh, so rolling windows slide.
  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);
  const { since, until, spanHours } = resolved;

  // Mirror the active filters into the URL (no navigation) so a refresh or a
  // shared link restores the same view. Defaults are omitted to keep URLs tidy.
  useEffect(() => {
    if (!appsLoaded) return;
    const p = new URLSearchParams();
    if (rangeValue.type === "custom") {
      p.set("since", rangeValue.since);
      p.set("until", rangeValue.until);
    } else if (rangeValue.id !== DEFAULT_PRESET_ID) {
      p.set("range", rangeValue.id);
    }
    if (apps.length > 0) {
      if (selectedAppSlugs.length === 0) p.set("apps", "none");
      else if (selectedAppSlugs.length < apps.length) p.set("apps", selectedAppSlugs.join(","));
    }
    if (selectedEnv) p.set("env", selectedEnv);
    if (activeMetric !== "requests") p.set("metric", activeMetric);
    if (sortKey !== "total_requests") p.set("sort", sortKey);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [appsLoaded, rangeValue, apps.length, selectedAppSlugs, selectedEnv, activeMetric, sortKey]);

  // Fetch apps + environments
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const list: AppOption[] = (data.apps || []).map(
            (a: { id: string; name: string; slug: string }) => ({ id: a.id, name: a.name, slug: a.slug })
          );
          setApps(list);
          // Seed the app selection from the URL (?apps=slug,slug or "none"),
          // dropping any slugs that no longer exist; default to all apps.
          const allSlugs = list.map((a) => a.slug);
          const param = initialFilters?.apps;
          if (param === "none") {
            setSelectedAppSlugs([]);
          } else if (param) {
            const wanted = param.split(",").filter(Boolean);
            const valid = allSlugs.filter((s) => wanted.includes(s));
            setSelectedAppSlugs(valid.length ? valid : allSlugs);
          } else {
            setSelectedAppSlugs(allSlugs);
          }
        }
      } catch {
        /* ignore */
      } finally {
        setAppsLoaded(true);
      }
    })();

    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [projectSlug]);

  // Build the shared query string for the active filters.
  const buildQuery = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams();
      // Omit app_slugs when every app is selected — that's the aggregate view.
      if (selectedAppSlugs.length && selectedAppSlugs.length < apps.length) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      } else if (selectedAppSlugs.length && apps.length === 0) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      }
      p.set("since", since);
      p.set("until", until);
      if (selectedEnv) p.set("environment", selectedEnv);
      for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
      return p.toString();
    },
    [selectedAppSlugs, apps.length, since, until, selectedEnv]
  );


  // Fetch summary + timeseries + endpoints whenever filters change.
  useEffect(() => {
    if (!appsLoaded) return;
    // Nothing selected → empty state, skip the network round-trip.
    if (apps.length > 0 && selectedAppSlugs.length === 0) {
      setSummary(EMPTY_SUMMARY);
      setSeries([]);
      setEndpoints([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const get = async <T,>(path: string, qs: string, fallback: T): Promise<T> => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/${path}?${qs}`);
        return res.ok ? ((await res.json()) as T) : fallback;
      } catch {
        return fallback;
      }
    };

    (async () => {
      setLoading(true);
      const baseQs = buildQuery();
      const [sum, ts, eps] = await Promise.all([
        get<Summary>("summary", baseQs, EMPTY_SUMMARY),
        get<TSPoint[]>("timeseries", baseQs, []),
        get<{ items?: EndpointStat[] } | EndpointStat[]>(
          "endpoints",
          buildQuery({ limit: "500" }),
          []
        ),
      ]);
      if (cancelled) return;
      setSummary(sum);
      setSeries(Array.isArray(ts) ? ts : []);
      const items = Array.isArray(eps) ? eps : eps.items || [];
      setEndpoints(items);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [projectSlug, appsLoaded, apps.length, selectedAppSlugs, buildQuery, refreshKey]);

  const cur = summary || EMPTY_SUMMARY;
  const rpm = cur.total_requests / Math.max(1, spanHours * 60);

  const chartData = useMemo(() => {
    // Buckets are hourly for short windows, daily beyond 48h (mirrors the
    // backend). RPM = requests ÷ minutes in the bucket, so divide by the right
    // span or the per-minute series is off by 24× on daily buckets.
    const bucketMinutes = spanHours <= 48 ? 60 : 1440;
    return (series || []).map((p) => {
        const errors = p.error_count || 0;
        const success = Math.max(0, (p.total_requests || 0) - errors);
        return {
          // The raw bucket is the X-axis category — it's unique per point, so
          // bars stay aligned and the tooltip resolves to the hovered bar.
          // (Using the human label collapses same-day buckets into one category,
          // which misaligns bars and shows the wrong bar's numbers on hover.)
          bucket: p.bucket,
          label: bucketLabel(p.bucket, spanHours),
          reqSuccess: success,
          reqErrors: errors,
          rpmSuccess: Number((success / bucketMinutes).toFixed(2)),
          rpmErrors: Number((errors / bucketMinutes).toFixed(2)),
          rate: Number((p.error_rate || 0).toFixed(2)),
          bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0),
        };
      });
  }, [series, spanHours]);

  // Per-metric config: drives the active tab highlight AND the shared chart.
  // "stack" metrics render success (green) + errors (red) stacked per bucket;
  // "area" metrics render a single filled series.
  const errTone = cur.error_rate >= 5 ? "bad" : cur.error_rate >= 1 ? "warn" : undefined;
  const METRICS: Record<
    MetricKey,
    | { label: string; value: string; tone?: "warn" | "bad"; kind: "stack"; successKey: string; errorKey: string; fmtY: (v: number) => string; fmtVal: (v: number) => string }
    | { label: string; value: string; tone?: "warn" | "bad"; kind: "area"; dataKey: string; color: string; fmtY: (v: number) => string; fmtVal: (v: number) => string }
  > = {
    requests: { label: "Total requests", value: fmtNum(cur.total_requests), kind: "stack", successKey: "reqSuccess", errorKey: "reqErrors", fmtY: fmtCompact, fmtVal: fmtNum },
    rpm: { label: "Requests per minute", value: rpm.toFixed(2), kind: "stack", successKey: "rpmSuccess", errorKey: "rpmErrors", fmtY: (v) => `${v}`, fmtVal: (v) => v.toFixed(2) },
    errors: { label: "Error rate", value: `${cur.error_rate.toFixed(1)} %`, tone: errTone, kind: "area", dataKey: "rate", color: RED, fmtY: (v) => `${v}%`, fmtVal: (v) => `${v}%` },
    data: { label: "Data transferred", value: fmtBytes(dataBytes(cur)), kind: "area", dataKey: "bytes", color: ACCENT, fmtY: fmtBytes, fmtVal: fmtBytes },
  };
  const active = METRICS[activeMetric];

  const sortedEndpoints = useMemo(() => {
    const val = (r: EndpointStat): number => {
      if (sortKey === "data") return dataBytes(r);
      if (sortKey === "error_rate") return r.error_rate || 0;
      return r.total_requests || 0;
    };
    return [...endpoints].sort((a, b) => val(b) - val(a));
  }, [endpoints, sortKey]);

  // Client-side endpoint filter (method or path). Bars stay scaled to the full
  // set's max so widths don't jump as you type.
  const filteredEndpoints = useMemo(() => {
    const q = endpointSearch.trim().toLowerCase();
    if (!q) return sortedEndpoints;
    return sortedEndpoints.filter(
      (r) => r.path.toLowerCase().includes(q) || r.method.toLowerCase().includes(q)
    );
  }, [sortedEndpoints, endpointSearch]);

  const maxRequests = useMemo(
    () => Math.max(1, ...endpoints.map((r) => r.total_requests)),
    [endpoints]
  );

  // Close the per-row kebab menu on any outside click.
  useEffect(() => {
    if (!kebabRow) return;
    const onClick = () => setKebabRow(null);
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [kebabRow]);

  const rowKey = (row: EndpointStat) => `${row.method}-${row.path}`;

  const copyPath = async (row: EndpointStat) => {
    try {
      await navigator.clipboard.writeText(row.path);
    } catch {
      /* clipboard unavailable */
    }
    setKebabRow(null);
  };

  const sortTh = (key: SortKey, label: string) => (
    <th
      className={`tf-th tf-th-right${sortKey === key ? " active" : ""}`}
      onClick={() => setSortKey(key)}
      aria-sort={sortKey === key ? "descending" : "none"}
    >
      {label}
      <span className="tf-th-arrow">{sortKey === key ? "↓" : ""}</span>
    </th>
  );

  return (
    <div className="tf">
      {/* ── Toolbar ── */}
      <div className="tf-toolbar">
        <h1 className="tf-title">Traffic</h1>
        <div className="tf-toolbar-spacer" />

        <AppFilter apps={apps} selected={selectedAppSlugs} onChange={setSelectedAppSlugs} />

        {environments.length > 0 && (
          <select
            className="tf-select"
            value={selectedEnv}
            onChange={(e) => setSelectedEnv(e.target.value)}
            aria-label="Environment"
          >
            <option value="">All envs</option>
            {environments.map((env) => (
              <option key={env} value={env}>{env}</option>
            ))}
          </select>
        )}

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <button
          type="button"
          className="tf-refresh"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={loading ? "tf-spin" : ""} />
        </button>
      </div>

      {/* ── Metrics + chart (metrics are tabs that drive the chart) ── */}
      <section className="tf-panel">
        <div className="tf-metrics" role="tablist" aria-label="Traffic metric">
          {(Object.keys(METRICS) as MetricKey[]).map((key) => {
            const m = METRICS[key];
            const isActive = key === activeMetric;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`tf-metric${isActive ? " active" : ""}${m.tone ? ` tf-metric-${m.tone}` : ""}`}
                onClick={() => setActiveMetric(key)}
              >
                <span className="tf-metric-label">{m.label}</span>
                <span className="tf-metric-value">{loading ? "—" : m.value}</span>
              </button>
            );
          })}
        </div>

        <div className="tf-panel-chart">
          {!loading && chartData.length > 0 && active.kind === "stack" && (
            <div className="tf-legend">
              <span className="tf-legend-item"><span className="tf-legend-dot" style={{ background: GREEN }} />Success</span>
              <span className="tf-legend-item"><span className="tf-legend-dot" style={{ background: RED }} />Errors</span>
            </div>
          )}
          {/* We measure the stage ourselves (stageWidth) and pass concrete
              numeric width/height to the chart instead of using recharts'
              ResponsiveContainer — that container always initialises its size
              to -1 on mount and logs a "width(-1)" warning before its observer
              fires. Driving width from our ResizeObserver keeps it responsive
              with no warning. key={active.kind} only remounts on bar↔area;
              same-type metric switches animate in place. */}
          <div ref={stageRef} className="tf-chart-stage" style={{ height: 220, width: "100%", minWidth: 0 }}>
            {!loading && chartData.length === 0 ? (
              <div className="tf-empty" style={{ height: "100%" }}>No traffic in this period.</div>
            ) : stageWidth === 0 ? null : active.kind === "stack" ? (
              <BarChart key="stack" width={stageWidth} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="18%">
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, spanHours)} tick={AXIS} minTickGap={24} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={AXIS} width={48} tickFormatter={active.fmtY} tickLine={false} axisLine={false} />
                <Tooltip content={<TfTooltip kind="stack" fmtVal={active.fmtVal} spanHours={spanHours} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                <Bar dataKey={active.successKey} name="Success" stackId="t" fill={GREEN} maxBarSize={30} animationDuration={300} />
                <Bar dataKey={active.errorKey} name="Errors" stackId="t" fill={RED} radius={[2, 2, 0, 0]} maxBarSize={30} animationDuration={300} />
              </BarChart>
            ) : (
              <AreaChart key="area" width={stageWidth} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id={`tfArea-${activeMetric}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={active.color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={active.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, spanHours)} tick={AXIS} minTickGap={24} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={AXIS} width={48} tickFormatter={active.fmtY} tickLine={false} axisLine={false} />
                <Tooltip content={<TfTooltip kind="area" name={active.label} fmtVal={active.fmtVal} spanHours={spanHours} />} cursor={{ stroke: active.color, strokeDasharray: "3 3" }} />
                <Area type="monotone" dataKey={active.dataKey} name={active.label} stroke={active.color} strokeWidth={2} fill={`url(#tfArea-${activeMetric})`} animationDuration={300} />
              </AreaChart>
            )}
            {loading && (
              <div className="tf-chart-loading" aria-hidden>
                {SKELETON_BARS.map((h, i) => (
                  <span key={i} className="tf-skeleton-bar" style={{ height: `${h}%` }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Endpoints table ── */}
      <section className="tf-table-card">
        <div className="tf-search-row">
          <div className="ep-search">
            <Search size={12} />
            <input
              type="text"
              value={endpointSearch}
              onChange={(e) => setEndpointSearch(e.target.value)}
              placeholder="Search endpoints…"
            />
            {endpointSearch && (
              <button
                type="button"
                className="ep-search-clear"
                onClick={() => setEndpointSearch("")}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="tf-table-wrap">
          {loading ? (
            <div className="tf-table-skeleton" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="tf-skeleton-row">
                  <span className="tf-skeleton tf-sk-method" />
                  <span className="tf-skeleton tf-sk-path" />
                  <span className="tf-skeleton tf-sk-num" />
                </div>
              ))}
            </div>
          ) : filteredEndpoints.length === 0 ? (
            <div className="tf-list-message">
              {endpoints.length === 0
                ? "No endpoint activity in this period."
                : "No endpoints match this search."}
            </div>
          ) : (
            <table className="tf-table">
              <thead>
                <tr>
                  <th className="tf-th tf-th-chevron" aria-hidden />
                  <th className="tf-th tf-th-left">Endpoint</th>
                  {sortTh("total_requests", "Requests")}
                  {sortTh("error_rate", "Error rate")}
                  {sortTh("data", "Data transferred")}
                  <th className="tf-th tf-th-actions" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {filteredEndpoints.map((row) => {
                  const key = rowKey(row);
                  return (
                  <tr
                    key={key}
                    className="tf-trow"
                    tabIndex={0}
                    role="button"
                    onClick={() => setOpenRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenRow(row);
                      }
                    }}
                  >
                    <td className="tf-td-chevron"><ChevronRight size={14} /></td>
                    <td className="tf-td-ep">
                      <span className={`ep-method ${methodColor(row.method)}`}>{row.method}</span>
                      <span className="tf-td-path">{row.path}</span>
                    </td>
                    <td className="tf-td-num">
                      <span className="tf-bar-wrap">
                        <span
                          className="tf-bar"
                          style={{ width: `${(row.total_requests / maxRequests) * 100}%` }}
                        />
                        <span className="tf-bar-val">{row.total_requests.toLocaleString()}</span>
                      </span>
                    </td>
                    <td className={`tf-td-num ${errToneClass(row.error_rate || 0)}`}>
                      {(row.error_rate || 0).toFixed(1)} %
                    </td>
                    <td className="tf-td-num">{fmtBytes(dataBytes(row))}</td>
                    <td className="tf-td-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="tf-kebab"
                        aria-label="Endpoint actions"
                        aria-haspopup="menu"
                        aria-expanded={kebabRow === key}
                        onClick={(e) => {
                          e.stopPropagation();
                          setKebabRow((cur) => (cur === key ? null : key));
                        }}
                      >
                        <MoreVertical size={15} />
                      </button>
                      {kebabRow === key && (
                        <div className="tf-kebab-menu" role="menu">
                          <button
                            type="button"
                            className="tf-kebab-opt"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              setKebabRow(null);
                              setOpenRow(row);
                            }}
                          >
                            View details
                          </button>
                          <button
                            type="button"
                            className="tf-kebab-opt"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyPath(row);
                            }}
                          >
                            Copy path
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {openRow && (
        <EndpointDetailInspector
          projectSlug={projectSlug}
          method={openRow.method}
          path={openRow.path}
          since={since}
          until={until}
          environment={selectedEnv || undefined}
          appSlugs={selectedAppSlugs.length === apps.length ? [] : selectedAppSlugs}
          rangeLabel={resolved.label}
          onClose={() => setOpenRow(null)}
        />
      )}
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────────────────── */

function AppFilter({
  apps,
  selected,
  onChange,
}: {
  apps: AppOption[];
  selected: string[];
  onChange: (slugs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onClickOutside);
      return () => document.removeEventListener("mousedown", onClickOutside);
    }
  }, [open]);

  if (apps.length === 0) return null;

  const allSelected = selected.length === apps.length;
  const label = allSelected
    ? "All apps"
    : selected.length === 0
      ? "No apps"
      : selected.length === 1
        ? apps.find((a) => a.slug === selected[0])?.name || "1 app"
        : `${selected.length} apps`;

  const toggle = (slug: string) => {
    if (selected.includes(slug)) onChange(selected.filter((s) => s !== slug));
    else onChange([...selected, slug]);
  };

  return (
    <div className="tf-appfilter" ref={ref}>
      <button
        type="button"
        className="tf-appfilter-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="tf-appfilter-label">{label}</span>
        <ChevronDown size={14} className="tf-appfilter-icon" />
      </button>

      {open && (
        <div className="tf-appfilter-menu">
          <button
            type="button"
            className="tf-appfilter-opt tf-appfilter-all"
            onClick={() => onChange(allSelected ? [] : apps.map((a) => a.slug))}
          >
            <span className={`tf-appfilter-check${allSelected ? " on" : ""}`}>
              {allSelected && <Check size={12} />}
            </span>
            <span className="tf-appfilter-name">All apps</span>
          </button>
          <div className="tf-appfilter-divider" />
          {apps.map((app) => {
            const on = selected.includes(app.slug);
            return (
              <button
                key={app.slug}
                type="button"
                className="tf-appfilter-opt"
                onClick={() => toggle(app.slug)}
              >
                <span className={`tf-appfilter-check${on ? " on" : ""}`}>
                  {on && <Check size={12} />}
                </span>
                <span className="tf-appfilter-name">{app.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TfTooltip({ active, payload, label, kind, name, fmtVal, spanHours }: any) {
  if (!active || !payload || !payload.length) return null;
  const f = fmtVal || fmtNum;
  // `label` is the bucket category (raw ISO) — format it for the header.
  const heading = bucketTipLabel(label, spanHours ?? 24);

  if (kind === "stack") {
    const success = payload.find((p: any) => p.name === "Success")?.value ?? 0;
    const errors = payload.find((p: any) => p.name === "Errors")?.value ?? 0;
    const total = success + errors;
    const rate = total > 0 ? (errors / total) * 100 : 0;
    return (
      <div className="tf-tip">
        <p className="tf-tip-label">{heading}</p>
        <p style={{ color: "var(--text-primary)" }}>Total: {f(total)}</p>
        <p style={{ color: GREEN }}>Success: {f(success)}</p>
        <p style={{ color: RED }}>Errors: {f(errors)} ({rate.toFixed(1)}%)</p>
      </div>
    );
  }

  const v = payload[0]?.value ?? 0;
  return (
    <div className="tf-tip">
      <p className="tf-tip-label">{heading}</p>
      <p style={{ color: payload[0]?.color || ACCENT }}>{name}: {f(v)}</p>
    </div>
  );
}
