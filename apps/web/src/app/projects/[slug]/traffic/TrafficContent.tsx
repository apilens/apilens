"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { Check, ChevronDown, ChevronRight, MoreVertical, RefreshCw, Search, X } from "lucide-react";
import Pagination from "@/components/aperture/Pagination";
import LiveNumber from "@/components/aperture/LiveNumber";
import LiveIndicator from "@/components/aperture/LiveIndicator";
import { useLivePoll } from "@/lib/useLivePoll";
import { fmtNum, fmtCompact, fmtBytes, dataBytes } from "@/lib/format";
import {
  type RangeValue,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import FilterBar from "../_shared/filters/FilterBar";
import { parseFilter } from "../_shared/filters/query";
import EndpointDetailInspector from "./EndpointDetailInspector";

/* ── Types ───────────────────────────────────────────────────────────── */

interface Summary {
  total_requests: number;
  error_count: number;
  error_rate: number;
  client_error_rate?: number;
  server_error_rate?: number;
  client_error_count?: number;
  server_error_count?: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  unique_endpoints: number;
  unique_consumers: number;
}

interface DeployEvent {
  id: string;
  app_slug: string;
  app_name: string;
  environment: string;
  release: string;
  commit: string;
  url: string;
  deployed_at: string;
}

interface TSPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  client_error_rate?: number;
  server_error_rate?: number;
  client_error_count?: number;
  server_error_count?: number;
  total_request_bytes: number;
  total_response_bytes: number;
}

type MetricKey = "requests" | "rpm" | "data" | "clientErr" | "serverErr" | "totalErr";

interface EndpointStat {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  client_error_rate?: number;
  server_error_rate?: number;
  client_error_count?: number;
  server_error_count?: number;
  total_request_bytes?: number;
  total_response_bytes?: number;
}

// Paginated shape returned by the endpoints analytics route.
interface EndpointsPage {
  items: EndpointStat[];
  total_count: number;
}

type AppOption = { id: string; name: string; slug: string };
type SortKey = "total_requests" | "client_error_rate" | "server_error_rate" | "error_rate" | "data";

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
  filter?: string;
  ep_method?: string;
  ep_path?: string;
}

// Migrate legacy ?env= / ?consumer= links into the unified filter string.
function seedFilter(f?: InitialFilters): string {
  if (f?.filter) return f.filter;
  const seed: string[] = [];
  if (f?.env) seed.push(`env:is:${f.env}`);
  if (f?.consumer) seed.push(`consumer:is:${f.consumer}`);
  return seed.join(";");
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
const RED = "#f87171"; // server 5xx / errors — soft red
const AMBER = "#fca5a5"; // client 4xx — light red
const GRID = "rgba(148,163,184,0.12)";
const AXIS = { fontSize: 10, fill: "var(--text-muted)" } as const;
// Static bar heights (%) for the chart loading skeleton.
const SKELETON_BARS = [58, 80, 46, 88, 62, 74, 52, 90, 66, 78, 48, 84];
// Endpoint rows per page — the page is fetched from the server on demand.
const EP_PAGE_SIZE = 25;

/* ── Helpers ─────────────────────────────────────────────────────────── */

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
function methodColor(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "ep-method-get";
  if (k === "POST") return "ep-method-post";
  if (k === "PUT") return "ep-method-put";
  if (k === "PATCH") return "ep-method-patch";
  if (k === "DELETE") return "ep-method-delete";
  return "ep-method-other";
}

/* ── Component ───────────────────────────────────────────────────────── */

export default function TrafficContent({ projectSlug, initialFilters }: Props) {
  const [apps, setApps] = useState<AppOption[]>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);

  // Unified rich filter (env, method, status, path, latency, consumer, …).
  // App scope stays as the dedicated AppFilter; time as the range picker.
  const [filter, setFilter] = useState(() => seedFilter(initialFilters));
  // Environment for the endpoint inspector's sub-queries, derived from filter.
  const filterEnv = useMemo(
    () => parseFilter(filter).find((p) => p.field === "env" && !p.negate)?.values[0] || "",
    [filter],
  );

  const [rangeValue, setRangeValue] = useState<RangeValue>(() => parseRange(initialFilters));
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    initialFilters?.sort === "client_error_rate" ||
    initialFilters?.sort === "server_error_rate" ||
    initialFilters?.sort === "error_rate" ||
    initialFilters?.sort === "data"
      ? (initialFilters.sort as SortKey)
      : "total_requests"
  );
  const [activeMetric, setActiveMetric] = useState<MetricKey>(() =>
    initialFilters?.metric === "rpm" ||
    initialFilters?.metric === "totalErr" ||
    initialFilters?.metric === "clientErr" ||
    initialFilters?.metric === "serverErr" ||
    initialFilters?.metric === "data"
      ? (initialFilters.metric as MetricKey)
      : "requests"
  );
  // Legend toggle: which stacked series are hidden (click a legend chip to
  // isolate, e.g. show only 4xx or only 5xx on the Total errors chart).
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);

  // Endpoint table: the search box, the open detail slide-over, and the
  // per-row kebab menu (keyed by `${method}-${path}`). Search, sort and paging
  // are all resolved server-side, so we only ever hold the current page's rows.
  const [endpointSearch, setEndpointSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Seed the open detail from the URL so an endpoint-detail link is shareable:
  // ?ep_method=GET&ep_path=/product/{id} reopens that endpoint on load.
  const [openRow, setOpenRow] = useState<EndpointStat | null>(() =>
    initialFilters?.ep_method && initialFilters?.ep_path
      ? {
          method: initialFilters.ep_method.toUpperCase(),
          path: initialFilters.ep_path,
          total_requests: 0,
          error_count: 0,
          error_rate: 0,
        }
      : null
  );
  const [kebabRow, setKebabRow] = useState<string | null>(null);
  const [endpointPage, setEndpointPage] = useState(1);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<TSPoint[] | null>(null);
  const [deploys, setDeploys] = useState<DeployEvent[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointStat[]>([]);
  const [endpointTotal, setEndpointTotal] = useState(0);
  const [endpointsLoading, setEndpointsLoading] = useState(true);
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
    } else {
      // Always surface the active range (including the 24h default) so the URL
      // fully describes the view and shared links keep their meaning.
      p.set("range", rangeValue.id);
    }
    if (apps.length > 0) {
      if (selectedAppSlugs.length === 0) p.set("apps", "none");
      else if (selectedAppSlugs.length < apps.length) p.set("apps", selectedAppSlugs.join(","));
    }
    if (filter) p.set("filter", filter);
    if (activeMetric !== "requests") p.set("metric", activeMetric);
    if (sortKey !== "total_requests") p.set("sort", sortKey);
    // Reflect the open endpoint-detail so the link is shareable / deep-linkable.
    if (openRow) {
      p.set("ep_method", openRow.method);
      p.set("ep_path", openRow.path);
    }
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [appsLoaded, rangeValue, apps.length, selectedAppSlugs, filter, activeMetric, sortKey, openRow]);

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
  }, [projectSlug]);

  // One fetch routine for both the initial/filtered load (silent=false → shows
  // skeletons) and the live poll (silent=true → swaps numbers in place). A
  // request-id guard drops stale responses so an in-flight poll never clobbers
  // a newer filter change.
  const reqId = useRef(0);
  const loadData = useCallback(
    async (silent: boolean) => {
      if (!appsLoaded) return;
      // Nothing selected → empty state, skip the network round-trip.
      if (apps.length > 0 && selectedAppSlugs.length === 0) {
        setSummary(EMPTY_SUMMARY);
        setSeries([]);
        setLoading(false);
        return;
      }

      // Resolve the range *at fetch time* so a rolling window (e.g. "last 24h")
      // slides forward on every poll. If we froze `until` at mount, new requests
      // would land past it and the live numbers would never climb.
      const { since: qSince, until: qUntil } = resolveRange(rangeValue);
      const buildQuery = (extra?: Record<string, string>) => {
        const p = new URLSearchParams();
        // Omit app_slugs when every app is selected — that's the aggregate view.
        if (selectedAppSlugs.length && selectedAppSlugs.length < apps.length) {
          p.set("app_slugs", selectedAppSlugs.join(","));
        } else if (selectedAppSlugs.length && apps.length === 0) {
          p.set("app_slugs", selectedAppSlugs.join(","));
        }
        p.set("since", qSince);
        p.set("until", qUntil);
        if (filter) p.set("filter", filter);
        for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
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

      const baseQs = buildQuery();

      // Deploys live outside /analytics; markers on the chart come from here.
      const getDeploys = async (): Promise<DeployEvent[]> => {
        try {
          const res = await fetch(`/api/projects/${projectSlug}/deploys?${baseQs}`);
          const data = res.ok ? await res.json() : [];
          return Array.isArray(data) ? data : [];
        } catch {
          return [];
        }
      };

      const myId = ++reqId.current;
      if (!silent) setLoading(true);
      const [sum, ts, deps] = await Promise.all([
        get<Summary>("summary", baseQs, EMPTY_SUMMARY),
        get<TSPoint[]>("timeseries", baseQs, []),
        getDeploys(),
      ]);
      // A newer request (filter change or a later poll) has superseded this one.
      if (myId !== reqId.current) return;
      setSummary(sum);
      setSeries(Array.isArray(ts) ? ts : []);
      setDeploys(deps);
      if (!silent) setLoading(false);
    },
    [projectSlug, appsLoaded, apps.length, selectedAppSlugs, rangeValue, filter]
  );

  // Endpoints table: server-side search + sort + pagination. Fetches ONLY the
  // page in view, so navigating pages (or the 5s live poll) transfers 25 rows
  // instead of the whole endpoint set. Its own request-id guard keeps a slow
  // page fetch from clobbering a newer one.
  const epReqId = useRef(0);
  const loadEndpoints = useCallback(
    async (silent: boolean) => {
      if (!appsLoaded) return;
      if (apps.length > 0 && selectedAppSlugs.length === 0) {
        setEndpoints([]);
        setEndpointTotal(0);
        setEndpointsLoading(false);
        return;
      }
      const { since: qSince, until: qUntil } = resolveRange(rangeValue);
      const p = new URLSearchParams();
      if (selectedAppSlugs.length && selectedAppSlugs.length < apps.length) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      } else if (selectedAppSlugs.length && apps.length === 0) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      }
      p.set("since", qSince);
      p.set("until", qUntil);
      if (filter) p.set("filter", filter);
      p.set("page", String(endpointPage));
      p.set("page_size", String(EP_PAGE_SIZE));
      p.set("sort_by", sortKey);
      p.set("sort_dir", "desc");
      if (debouncedSearch) p.set("q", debouncedSearch);

      const myId = ++epReqId.current;
      if (!silent) setEndpointsLoading(true);
      const empty: EndpointsPage = { items: [], total_count: 0 };
      let data: EndpointsPage = empty;
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoints?${p.toString()}`);
        data = res.ok ? ((await res.json()) as EndpointsPage) : empty;
      } catch {
        data = empty;
      }
      if (myId !== epReqId.current) return;
      setEndpoints(data.items || []);
      setEndpointTotal(data.total_count || 0);
      if (!silent) setEndpointsLoading(false);
    },
    [projectSlug, appsLoaded, apps.length, selectedAppSlugs, rangeValue, filter, endpointPage, sortKey, debouncedSearch]
  );

  // Initial load + reload on any filter/range change or manual refresh.
  useEffect(() => {
    loadData(false);
  }, [loadData, refreshKey]);
  useEffect(() => {
    loadEndpoints(false);
  }, [loadEndpoints, refreshKey]);

  // Debounce the search box so typing fires at most one request per pause.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(endpointSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [endpointSearch]);

  // Jump back to page 1 whenever the query that defines the list changes, so we
  // never sit on a page that no longer exists.
  useEffect(() => {
    setEndpointPage(1);
  }, [debouncedSearch, sortKey, filter, selectedAppSlugs, rangeValue]);

  // Live polling: silently refetch every 5s, sliding the rolling window and
  // rolling the numbers in place. Auto-pauses when the tab is hidden.
  const poll = useLivePoll({
    intervalMs: 5000,
    onTick: () => {
      loadData(true);
      // Only live-refresh the endpoints table while on page 1. Deeper pages are
      // a historical slice the user is inspecting — re-fetching them every 5s
      // would spend a count + aggregate query for rows that aren't changing.
      if (endpointPage === 1) loadEndpoints(true);
    },
    deps: [loadData, loadEndpoints],
  });

  const cur = summary || EMPTY_SUMMARY;
  const rpm = cur.total_requests / Math.max(1, spanHours * 60);

  const chartData = useMemo(() => {
    // Buckets are hourly for short windows, daily beyond 48h (mirrors the
    // backend). RPM = requests ÷ minutes in the bucket, so divide by the right
    // span or the per-minute series is off by 24× on daily buckets.
    const bucketMinutes = spanHours <= 48 ? 60 : 1440;
    return (series || []).map((p) => {
        const total = p.total_requests || 0;
        // Split by status class: 4xx (client) and 5xx (server) come straight
        // from the backend; everything else (2xx/3xx) is "success".
        const client = p.client_error_count || 0;
        const server = p.server_error_count || 0;
        const success = Math.max(0, total - client - server);
        return {
          // The raw bucket is the X-axis category — it's unique per point, so
          // bars stay aligned and the tooltip resolves to the hovered bar.
          // (Using the human label collapses same-day buckets into one category,
          // which misaligns bars and shows the wrong bar's numbers on hover.)
          bucket: p.bucket,
          label: bucketLabel(p.bucket, spanHours),
          success,           // 2xx/3xx
          client,            // 4xx
          server,            // 5xx
          rpm: Number((total / bucketMinutes).toFixed(2)),
          clientRate: Number((p.client_error_rate || 0).toFixed(2)),
          serverRate: Number((p.server_error_rate || 0).toFixed(2)),
          totalRate: Number((p.error_rate || 0).toFixed(2)),
          bytes: (p.total_request_bytes || 0) + (p.total_response_bytes || 0),
        };
      });
  }, [series, spanHours]);

  // Deploy markers: snap each deploy to the chart bucket containing it (the
  // X axis is categorical, so a marker must land on an exact bucket key).
  // Multiple releases in one bucket collapse into a single labelled line.
  const deployMarkers = useMemo(() => {
    if (!deploys.length || !series?.length) return [];
    const bucketMs = (spanHours <= 48 ? 60 : 1440) * 60_000;
    const buckets = series
      .map((p) => ({ key: p.bucket, t: new Date(p.bucket).getTime() }))
      .filter((b) => !isNaN(b.t));
    const byBucket = new Map<string, string[]>();
    for (const d of deploys) {
      const t = new Date(d.deployed_at).getTime();
      if (isNaN(t)) continue;
      const hit = buckets.find((b) => t >= b.t && t < b.t + bucketMs);
      if (!hit) continue;
      const releases = byBucket.get(hit.key) || [];
      if (d.release && !releases.includes(d.release)) releases.push(d.release);
      byBucket.set(hit.key, releases);
    }
    return Array.from(byBucket, ([bucket, releases]) => {
      const label = releases.join(", ");
      return { bucket, label: label.length > 18 ? `${label.slice(0, 17)}…` : label };
    });
  }, [deploys, series, spanHours]);

  // Per-metric config: drives the active tab highlight AND the shared chart.
  // "stack" metrics render success (green) + errors (red) stacked per bucket;
  // "area" metrics render a single filled series.
  const toneFor = (r: number): "warn" | "bad" | undefined => (r >= 5 ? "bad" : r >= 1 ? "warn" : undefined);
  const clientRate = cur.client_error_rate || 0;
  const serverRate = cur.server_error_rate || 0;
  const totalRate = cur.error_rate || 0;
  // `num`/`fmt` feed the live odometer (raw value + a formatter that exactly
  // reproduces the tile string); `invert` flags metrics where lower is better,
  // so a drop flashes green. `value` stays for any non-live fallback.
  type MetricBase = {
    label: string;
    value: string;
    num: number;
    fmt: (v: number) => string;
    invert?: boolean;
    tone?: "warn" | "bad";
    fmtY: (v: number) => string;
    fmtVal: (v: number) => string;
  };
  type StackSeries = { key: string; name: string; color: string; pct?: number };
  const METRICS: Record<
    MetricKey,
    | (MetricBase & { kind: "stack"; series: StackSeries[] })
    | (MetricBase & { kind: "area"; dataKey: string; color: string })
  > = {
    // Total requests → Success (green, 2xx/3xx) / 4xx (amber) / 5xx (red) stacked (issue #146).
    requests: {
      label: "Total requests", value: fmtNum(cur.total_requests), num: cur.total_requests, fmt: fmtNum,
      kind: "stack", fmtY: fmtCompact, fmtVal: fmtNum,
      series: [
        { key: "success", name: "Success", color: GREEN },
        { key: "client", name: "4xx", color: AMBER },
        { key: "server", name: "5xx", color: RED },
      ],
    },
    // RPM → area chart (issue #146).
    rpm: { label: "Requests per minute", value: rpm.toFixed(2), num: rpm, fmt: (v) => v.toFixed(2), kind: "area", dataKey: "rpm", color: ACCENT, fmtY: (v) => `${v}`, fmtVal: (v) => v.toFixed(2) },
    data: { label: "Data transferred", value: fmtBytes(dataBytes(cur)), num: dataBytes(cur), fmt: fmtBytes, kind: "area", dataKey: "bytes", color: ACCENT, fmtY: fmtBytes, fmtVal: fmtBytes },
    // 4xx / 5xx rates get their own tabs as single-series area charts; the
    // combined Total errors tab below keeps the stacked view.
    clientErr: {
      label: "4xx errors", value: `${clientRate.toFixed(1)} %`, num: clientRate, fmt: (v) => `${v.toFixed(1)} %`, invert: true, tone: toneFor(clientRate),
      kind: "area", dataKey: "clientRate", color: AMBER, fmtY: (v) => `${v}%`, fmtVal: (v) => `${v}%`,
    },
    serverErr: {
      label: "5xx errors", value: `${serverRate.toFixed(1)} %`, num: serverRate, fmt: (v) => `${v.toFixed(1)} %`, invert: true, tone: toneFor(serverRate),
      kind: "area", dataKey: "serverRate", color: RED, fmtY: (v) => `${v}%`, fmtVal: (v) => `${v}%`,
    },
    // Total errors → 4xx (amber) / 5xx (red) stacked. Stacking the two rates
    // sums to the total error rate, so units match the tile (issue #146).
    totalErr: {
      label: "Total errors", value: `${totalRate.toFixed(1)} %`, num: totalRate, fmt: (v) => `${v.toFixed(1)} %`, invert: true, tone: toneFor(totalRate),
      kind: "stack", fmtY: (v) => `${v}%`, fmtVal: (v) => `${v}%`,
      series: [
        { key: "clientRate", name: "4xx", color: AMBER, pct: clientRate },
        { key: "serverRate", name: "5xx", color: RED, pct: serverRate },
      ],
    },
  };
  const active = METRICS[activeMetric];

  // Legend interaction for stacked charts: the visible series after toggles,
  // and a click handler that hides/shows a series (never hides the last one).
  const stackSeries = active.kind === "stack" ? active.series : [];
  const visibleSeries = stackSeries.filter((s) => !hiddenSeries.has(s.key));
  const toggleSeries = useCallback((key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (visibleSeries.length > 1) {
        // Keep at least one series visible so the chart never goes blank.
        next.add(key);
      }
      return next;
    });
  }, [visibleSeries.length]);
  const selectMetric = useCallback((key: MetricKey) => {
    setActiveMetric(key);
    setHiddenSeries(new Set()); // switching tabs shows all series again
  }, []);

  // Request bars scale to the current page's busiest endpoint. (With the
  // default requests-desc sort, page 1's top row is the global max.)
  const maxRequests = useMemo(
    () => Math.max(1, ...endpoints.map((r) => r.total_requests)),
    [endpoints]
  );

  // Paging is server-side: totalPages derives from the server's total_count and
  // `endpoints` already holds exactly the current page's rows.
  const totalPages = Math.max(1, Math.ceil(endpointTotal / EP_PAGE_SIZE));
  const currentPage = Math.min(endpointPage, totalPages);
  // If the total shrank under us (e.g. a narrower search), fall onto the last
  // still-valid page rather than showing an empty one.
  useEffect(() => {
    if (endpointPage > totalPages) setEndpointPage(totalPages);
  }, [endpointPage, totalPages]);

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
      {/* ── Toolbar: filter search + scope/time controls on one line ── */}
      <div className="tf-toolbar">
        <div className="tf-filter-grow">
          <FilterBar projectSlug={projectSlug} value={filter} onChange={setFilter} exclude={["app"]} />
        </div>

        <AppFilter apps={apps} selected={selectedAppSlugs} onChange={setSelectedAppSlugs} />

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <LiveIndicator live={poll.live} onToggle={poll.toggle} lastTickAt={poll.lastTickAt} />

        <button
          type="button"
          className="tf-refresh"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh now"
          aria-label="Refresh now"
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
                onClick={() => selectMetric(key)}
              >
                <span className="tf-metric-labelrow">
                  <span className="tf-metric-label">{m.label}</span>
                  {/* Total errors: subtle 4xx / 5xx caption in the label row, so
                      the tile keeps the same height and the number stays clean. */}
                  {key === "totalErr" && !loading && (
                    <span className="tf-metric-breakdown">
                      <span className="err-4xx">4xx {clientRate.toFixed(1)}%</span>
                      <span className="err-5xx">5xx {serverRate.toFixed(1)}%</span>
                    </span>
                  )}
                </span>
                <span className="tf-metric-value">
                  {loading ? "—" : <LiveNumber value={m.num} format={m.fmt} invertTone={m.invert} />}
                </span>
              </button>
            );
          })}
        </div>

        <div className="tf-panel-chart">
          {!loading && chartData.length > 0 && active.kind === "stack" && (
            <div className="tf-legend">
              {active.series.map((s, idx) => {
                const hidden = hiddenSeries.has(s.key);
                return (
                  <Fragment key={s.key}>
                    {/* "4xx + 5xx = total" breakdown on the Total errors chart. */}
                    {idx > 0 && active.series.every((x) => x.pct !== undefined) && (
                      <span className="tf-legend-op">+</span>
                    )}
                    <button
                      type="button"
                      className={`tf-legend-item tf-legend-toggle${hidden ? " is-off" : ""}`}
                      onClick={() => toggleSeries(s.key)}
                      aria-pressed={!hidden}
                      title={hidden ? `Show ${s.name}` : `Show only the others — hide ${s.name}`}
                    >
                      <span className="tf-legend-dot" style={{ background: hidden ? "transparent" : s.color, borderColor: s.color }} />
                      {s.name}{s.pct !== undefined ? ` ${s.pct.toFixed(1)}%` : ""}
                    </button>
                  </Fragment>
                );
              })}
              {active.series.every((s) => s.pct !== undefined) && (
                <span className="tf-legend-total">= Total {totalRate.toFixed(1)}%</span>
              )}
            </div>
          )}
          {/* We measure the stage ourselves (stageWidth) and pass concrete
              numeric width/height to the chart instead of using recharts'
              ResponsiveContainer — that container always initialises its size
              to -1 on mount and logs a "width(-1)" warning before its observer
              fires. Driving width from our ResizeObserver keeps it responsive
              with no warning. key={activeMetric} remounts the chart on every
              tab switch — recharts keeps rendering the previous series if only
              the Area/Bar dataKey changes without a new key, so the chart must
              remount to stay in sync with the active tab. */}
          <div ref={stageRef} className="tf-chart-stage" style={{ height: 220, width: "100%", minWidth: 0 }}>
            {!loading && chartData.length === 0 ? (
              <div className="tf-empty" style={{ height: "100%" }}>No traffic in this period.</div>
            ) : stageWidth === 0 ? null : active.kind === "stack" ? (
              <BarChart key={`stack-${activeMetric}-${visibleSeries.map((s) => s.key).join("")}`} width={stageWidth} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="18%">
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, spanHours)} tick={AXIS} minTickGap={24} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tick={AXIS} width={48} tickFormatter={active.fmtY} tickLine={false} axisLine={false} />
                <Tooltip content={<TfTooltip kind="stack" fmtVal={active.fmtVal} spanHours={spanHours} />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                {deployMarkers.map((m) => (
                  <ReferenceLine
                    key={m.bucket}
                    x={m.bucket}
                    stroke={ACCENT}
                    strokeDasharray="4 3"
                    strokeOpacity={0.55}
                    label={{ value: m.label, position: "insideTopRight", fill: "var(--text-muted)", fontSize: 9 }}
                  />
                ))}
                {visibleSeries.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    stackId="t"
                    fill={s.color}
                    // Round only the topmost visible segment of each stacked bar.
                    radius={i === visibleSeries.length - 1 ? [2, 2, 0, 0] : undefined}
                    maxBarSize={30}
                    animationDuration={300}
                  />
                ))}
              </BarChart>
            ) : (
              <AreaChart key={`area-${activeMetric}`} width={stageWidth} height={220} data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
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
                {deployMarkers.map((m) => (
                  <ReferenceLine
                    key={m.bucket}
                    x={m.bucket}
                    stroke={ACCENT}
                    strokeDasharray="4 3"
                    strokeOpacity={0.55}
                    label={{ value: m.label, position: "insideTopRight", fill: "var(--text-muted)", fontSize: 9 }}
                  />
                ))}
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
          {endpointsLoading ? (
            <div className="tf-table-skeleton" aria-hidden>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="tf-skeleton-row">
                  <span className="tf-skeleton tf-sk-method" />
                  <span className="tf-skeleton tf-sk-path" />
                  <span className="tf-skeleton tf-sk-num" />
                </div>
              ))}
            </div>
          ) : endpoints.length === 0 ? (
            <div className="tf-list-message">
              {debouncedSearch
                ? "No endpoints match this search."
                : "No endpoint activity in this period."}
            </div>
          ) : (
            <table className="tf-table">
              <thead>
                <tr>
                  <th className="tf-th tf-th-chevron" aria-hidden />
                  <th className="tf-th tf-th-left">Endpoint</th>
                  {sortTh("total_requests", "Requests")}
                  {sortTh("client_error_rate", "Client 4xx")}
                  {sortTh("server_error_rate", "Server 5xx")}
                  {sortTh("error_rate", "Total")}
                  {sortTh("data", "Data transferred")}
                  <th className="tf-th tf-th-actions" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {endpoints.map((row) => {
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
                        <span className="tf-bar-val"><LiveNumber value={row.total_requests} format={fmtNum} hideDelta /></span>
                      </span>
                    </td>
                    <td className={`tf-td-num ${(row.client_error_rate || 0) > 0 ? "err-4xx" : ""}`}>
                      {(row.client_error_rate || 0).toFixed(1)} %
                    </td>
                    <td className={`tf-td-num ${(row.server_error_rate || 0) > 0 ? "err-5xx" : ""}`}>
                      {(row.server_error_rate || 0).toFixed(1)} %
                    </td>
                    <td className={`tf-td-num ${(row.error_rate || 0) >= 5 ? "tf-err-bad" : (row.error_rate || 0) >= 1 ? "tf-err-warn" : ""}`}>
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

        {!endpointsLoading && endpointTotal > 0 && (
          <div className="tf-pagination">
            <span className="tf-pagination-info">
              Showing {((currentPage - 1) * EP_PAGE_SIZE + 1).toLocaleString()}–
              {Math.min(currentPage * EP_PAGE_SIZE, endpointTotal).toLocaleString()} of{" "}
              {endpointTotal.toLocaleString()} endpoint{endpointTotal === 1 ? "" : "s"}
            </span>
            <Pagination page={currentPage} totalPages={totalPages} onChange={setEndpointPage} />
          </div>
        )}
      </section>

      {openRow && (
        <EndpointDetailInspector
          projectSlug={projectSlug}
          method={openRow.method}
          path={openRow.path}
          since={since}
          until={until}
          environment={filterEnv || undefined}
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
    // Generic over 2 or 3 stacked series (status classes / error classes).
    const total = payload.reduce((s: number, p: any) => s + (p.value || 0), 0);
    return (
      <div className="tf-tip">
        <p className="tf-tip-label">{heading}</p>
        <p style={{ color: "var(--text-primary)" }}>Total: {f(total)}</p>
        {payload.map((p: any, i: number) => (
          <p key={i} style={{ color: p.color || p.fill || ACCENT }}>{p.name}: {f(p.value ?? 0)}</p>
        ))}
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
