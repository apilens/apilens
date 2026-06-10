"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X, ChevronDown } from "lucide-react";
import EndpointDetailPane from "./EndpointDetailPane";

interface ProjectEndpointsContentProps {
  projectSlug: string;
}

const TIME_RANGES = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

type EndpointStat = {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes?: number;
  total_response_bytes?: number;
  last_seen_at?: string | null;
  // Set only in grouped (multi-app) mode so a row knows which app it belongs to.
  appSlug?: string;
};

type ViewMode = "overview" | "inspect";
type SortKey = "method" | "path" | "total_requests" | "error_rate" | "avg_response_time_ms" | "p95_response_time_ms" | "data" | "last_seen_at";

function dataBytes(r: EndpointStat): number {
  return (r.total_request_bytes || 0) + (r.total_response_bytes || 0);
}
function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function fmtMsShort(n: number): string {
  if (!n) return "—";
  return `${Math.round(n)} ms`;
}
function timeAgo(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts).getTime();
  if (isNaN(d)) return "—";
  const m = Math.floor((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function healthClass(errRate: number): string {
  if (errRate >= 5) return "ep-health-bad";
  if (errRate >= 1) return "ep-health-warn";
  return "ep-health-ok";
}

type SelectedEndpoint = { method: string; path: string; appSlug?: string };
type AppOption = { id: string; name: string; slug: string };

// True identity of a row: in grouped mode an endpoint is keyed by (app, method, path)
// because the same path can exist under more than one app.
function sameEndpoint(a: SelectedEndpoint | null, row: { method: string; path: string; appSlug?: string }): boolean {
  if (!a) return false;
  if (a.method !== row.method || a.path !== row.path) return false;
  // Only compare app when the selection carries one (grouped mode).
  if (a.appSlug != null) return a.appSlug === row.appSlug;
  return true;
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

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

const RANGE_VALUES = [1, 6, 24, 168, 720];
const RANGE_LABELS = ["1h", "6h", "24h", "7d", "30d"];

function rangeLabel(value: number): string {
  const idx = RANGE_VALUES.indexOf(value);
  return idx >= 0 ? RANGE_LABELS[idx] : "24h";
}

export default function ProjectEndpointsContent({ projectSlug }: ProjectEndpointsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [apps, setApps] = useState<AppOption[]>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [stats, setStats] = useState<EndpointStat[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedRange, setSelectedRange] = useState(24);
  const [search, setSearch] = useState("");
  const [selectedEndpoint, setSelectedEndpoint] = useState<SelectedEndpoint | null>(null);

  // Table (compare all endpoints) vs Inspect (drill into one). Default to Table.
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [sortKey, setSortKey] = useState<SortKey>("total_requests");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Collapsed app sections (by app slug) in the grouped list.
  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(new Set());

  // Which pane the keyboard drives: the endpoint list or the calls pane.
  const [focusZone, setFocusZone] = useState<"list" | "calls">("list");
  const listBodyRef = useRef<HTMLDivElement>(null);

  const [isInitialized, setIsInitialized] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Track viewport for the mobile list/detail swap
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Initialize from URL parameters
  useEffect(() => {
    if (isInitialized) return;

    const range = searchParams.get("range");
    const env = searchParams.get("env");
    const app = searchParams.get("app");
    const appsParam = searchParams.get("apps");
    const q = searchParams.get("q");
    const method = searchParams.get("method");
    const path = searchParams.get("path");
    const epApp = searchParams.get("ep_app");
    const view = searchParams.get("view");

    if (view === "inspect" || view === "overview") setViewMode(view);
    if (range) {
      const parsed = parseInt(range, 10);
      if (RANGE_VALUES.includes(parsed)) setSelectedRange(parsed);
    }
    if (env) setSelectedEnv(env);
    if (appsParam) {
      setSelectedAppSlugs(appsParam.split(",").filter(Boolean));
    } else if (app) {
      setSelectedAppSlugs([app]);
    }
    if (q) setSearch(q);
    if (method && path) setSelectedEndpoint({ method, path, appSlug: epApp || undefined });

    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Keep the URL in sync (shallow — does not re-fetch)
  useEffect(() => {
    if (!isInitialized) return;

    const params = new URLSearchParams();
    if (viewMode !== "overview") params.set("view", viewMode);
    if (selectedRange !== 24) params.set("range", String(selectedRange));
    if (selectedEnv) params.set("env", selectedEnv);
    if (selectedAppSlugs.length > 0 && selectedAppSlugs.length < apps.length) {
      params.set("apps", selectedAppSlugs.join(","));
    }
    if (search) params.set("q", search);
    // The open endpoint only belongs in the URL while inspecting it. In Table
    // view nothing is "open" (the auto-selection is just a pre-pick for when you
    // switch to Inspect), so keep those params out of the URL.
    if (selectedEndpoint && viewMode === "inspect") {
      params.set("method", selectedEndpoint.method);
      params.set("path", selectedEndpoint.path);
      if (selectedEndpoint.appSlug) params.set("ep_app", selectedEndpoint.appSlug);
    }

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });
  }, [isInitialized, viewMode, selectedRange, selectedEnv, selectedAppSlugs, search, selectedEndpoint, apps.length, router]);

  // Fetch apps and environments
  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const list: AppOption[] = (data.apps || []).map(
            (a: { id: string; name: string; slug: string }) => ({
              id: a.id,
              name: a.name,
              slug: a.slug,
            })
          );
          setApps(list);

          if (!isInitialized && selectedAppSlugs.length === 0) {
            setSelectedAppSlugs(list.map((a) => a.slug));
          } else if (isInitialized && selectedAppSlugs.length > 0) {
            const validSlugs = selectedAppSlugs.filter((slug) => list.some((a) => a.slug === slug));
            if (validSlugs.length !== selectedAppSlugs.length) {
              setSelectedAppSlugs(validSlugs.length > 0 ? validSlugs : list.map((a) => a.slug));
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch apps:", err);
      }
    }

    async function fetchEnvironments() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch (err) {
        console.error("Failed to fetch environments:", err);
      }
    }

    fetchApps();
    fetchEnvironments();
  }, [projectSlug, isInitialized, selectedAppSlugs]);

  const since = useMemo(
    () => new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString(),
    [selectedRange]
  );

  // When a project has more than one app we render the list grouped by app, so we
  // fetch each app's endpoints separately (the `app_slugs` filter already scopes
  // per app) and tag every row with its app slug. Single-app projects stay flat.
  const grouped = apps.length > 1;

  // Fetch endpoint list
  useEffect(() => {
    let cancelled = false;

    async function fetchOne(slug: string | null): Promise<EndpointStat[]> {
      const params = new URLSearchParams();
      if (slug) params.set("app_slugs", slug);
      params.set("since", since);
      if (selectedEnv) params.set("environment", selectedEnv);
      params.set("limit", "500");
      const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoints?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      const items: EndpointStat[] = data.items || data || [];
      return slug ? items.map((it) => ({ ...it, appSlug: slug })) : items;
    }

    async function fetchEndpoints() {
      setLoading(true);
      try {
        if (grouped) {
          // Fetch only the apps currently in scope (all of them, or the one the
          // toolbar filter narrows to), then flatten in stable app order.
          const slugs = selectedAppSlugs.length ? selectedAppSlugs : apps.map((a) => a.slug);
          const results = await Promise.all(slugs.map((slug) => fetchOne(slug)));
          if (cancelled) return;
          const bySlug = new Map(slugs.map((slug, i) => [slug, results[i]]));
          const ordered: EndpointStat[] = [];
          for (const app of apps) {
            const rows = bySlug.get(app.slug);
            if (rows) ordered.push(...rows);
          }
          setStats(ordered);
        } else {
          const items = await fetchOne(selectedAppSlugs.length ? selectedAppSlugs.join(",") : null);
          if (cancelled) return;
          setStats(items);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchEndpoints();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, selectedAppSlugs, since, selectedEnv, grouped, apps]);

  const filteredStats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stats;
    return stats.filter(
      (row) => row.path.toLowerCase().includes(q) || row.method.toLowerCase().includes(q)
    );
  }, [stats, search]);

  // Sorted rows for the Table view (flat across apps).
  const sortedStats = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (r: EndpointStat): number | string => {
      switch (sortKey) {
        case "method": return r.method;
        case "path": return r.path;
        case "data": return dataBytes(r);
        case "last_seen_at": return r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
        default: return (r[sortKey] as number) || 0;
      }
    };
    return [...filteredStats].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [filteredStats, sortKey, sortDir]);

  const maxRequests = useMemo(
    () => Math.max(1, ...filteredStats.map((r) => r.total_requests)),
    [filteredStats]
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "method" || key === "path" ? "asc" : "desc");
    }
  };

  const openInInspect = (row: { method: string; path: string; appSlug?: string }) => {
    setSelectedEndpoint({ method: row.method, path: row.path, appSlug: row.appSlug });
    setViewMode("inspect");
    setFocusZone("list");
  };

  const appName = (slug?: string) => apps.find((a) => a.slug === slug)?.name || "";

  const sortableTh = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <th
      className={`ep-th ep-th-${align}${sortKey === key ? " active" : ""}`}
      onClick={() => toggleSort(key)}
      aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      <span className="ep-th-arrow">{sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}</span>
    </th>
  );

  // Group filtered rows by app (stable app order), dropping apps with no matches.
  const groups = useMemo(() => {
    if (!grouped) return null;
    const bySlug = new Map<string, EndpointStat[]>();
    for (const row of filteredStats) {
      const slug = row.appSlug ?? "";
      const bucket = bySlug.get(slug);
      if (bucket) bucket.push(row);
      else bySlug.set(slug, [row]);
    }
    return apps
      .filter((a) => bySlug.has(a.slug))
      .map((a) => ({ app: a, rows: bySlug.get(a.slug)! }));
  }, [grouped, filteredStats, apps]);

  // Rows the keyboard can actually land on: in grouped mode, skip collapsed sections.
  const visibleRows = useMemo(() => {
    if (!groups) return filteredStats;
    const out: EndpointStat[] = [];
    for (const g of groups) {
      if (collapsedApps.has(g.app.slug)) continue;
      out.push(...g.rows);
    }
    return out;
  }, [groups, filteredStats, collapsedApps]);

  const toggleApp = (slug: string) =>
    setCollapsedApps((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const selectRow = (row: EndpointStat) =>
    setSelectedEndpoint({ method: row.method, path: row.path, appSlug: row.appSlug });

  const renderRow = (row: EndpointStat, nested: boolean) => {
    const sel = sameEndpoint(selectedEndpoint, row);
    return (
      <button
        key={`${row.appSlug ?? ""}-${row.method}-${row.path}`}
        type="button"
        className={`ep-row${nested ? " ep-row--nested" : ""}${sel ? " selected" : ""}${
          sel && focusZone === "list" ? " is-cursor" : ""
        }`}
        onClick={() => {
          selectRow(row);
          setFocusZone("list");
        }}
      >
        <span className={`ep-method ${methodColor(row.method)}`}>{row.method.slice(0, 4)}</span>
        <span className="ep-path">{row.path}</span>
        <span className={`ep-row-health ${healthClass(row.error_rate || 0)}`} />
        <span className="ep-row-count">{fmtCount(row.total_requests)}</span>
      </button>
    );
  };

  // Auto-select the first endpoint, and recover when the current selection drops
  // out of scope (filter/search change). Collapsing a group does NOT reset the
  // selection — staleness is judged against filteredStats, not the visible rows.
  useEffect(() => {
    if (loading) return;
    const stillValid =
      selectedEndpoint && filteredStats.some((r) => sameEndpoint(selectedEndpoint, r));
    if (stillValid) return;
    const fallback = visibleRows[0] ?? filteredStats[0];
    if (fallback) {
      setSelectedEndpoint({ method: fallback.method, path: fallback.path, appSlug: fallback.appSlug });
    } else if (selectedEndpoint) {
      setSelectedEndpoint(null);
    }
  }, [loading, filteredStats, visibleRows, selectedEndpoint]);

  const selectedIndex = useMemo(() => {
    if (!selectedEndpoint) return -1;
    return visibleRows.findIndex((r) => sameEndpoint(selectedEndpoint, r));
  }, [visibleRows, selectedEndpoint]);

  // ── Keyboard navigation for the endpoint list ──
  // ↑/↓ move the selection; Enter or → hand the cursor to the calls pane.
  useEffect(() => {
    if (focusZone !== "list") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) {
        return;
      }
      if (!visibleRows.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, visibleRows.length - 1);
        selectRow(visibleRows[next]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = selectedIndex < 0 ? 0 : Math.max(selectedIndex - 1, 0);
        selectRow(visibleRows[prev]);
      } else if ((e.key === "Enter" || e.key === "ArrowRight") && selectedEndpoint) {
        e.preventDefault();
        setFocusZone("calls");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusZone, visibleRows, selectedIndex, selectedEndpoint]);

  // Keep the keyboard-selected endpoint scrolled into view.
  useEffect(() => {
    if (focusZone !== "list") return;
    listBodyRef.current?.querySelector(".ep-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, focusZone]);

  const summaryStats = useMemo(() => {
    const rows = filteredStats;
    const totalReqs = rows.reduce((a, r) => a + r.total_requests, 0);
    const totalErrors = rows.reduce((a, r) => a + (r.error_count || 0), 0);
    const errRate = totalReqs ? (totalErrors / totalReqs) * 100 : 0;
    const weightedAvgMs = totalReqs
      ? rows.reduce((a, r) => a + (r.avg_response_time_ms || 0) * r.total_requests, 0) / totalReqs
      : 0;
    const p95 = rows.length ? Math.max(...rows.map((r) => r.p95_response_time_ms || 0)) : 0;
    const totalData = rows.reduce((a, r) => a + dataBytes(r), 0);
    const activeCount = rows.filter((r) => r.total_requests > 0).length;
    const successRate = totalReqs ? ((totalReqs - totalErrors) / totalReqs) * 100 : 0;
    return { totalReqs, totalErrors, errRate, weightedAvgMs, p95, totalData, endpointCount: rows.length, activeCount, successRate };
  }, [filteredStats]);

  const totalRequests = summaryStats.totalReqs;

  return (
    <div className="ep-workspace">
      {/* ── Toolbar ── */}
      <div className="ep-toolbar">
        <div className="ep-viewtoggle" role="tablist" aria-label="View mode">
          {([
            ["overview", "Overview"],
            ["inspect", "Inspect"],
          ] as [ViewMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              className={`ep-viewtoggle-btn${viewMode === mode ? " active" : ""}`}
              onClick={() => setViewMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ep-search">
          <Search size={12} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter endpoints…"
            onKeyDown={(e) => {
              if (!visibleRows.length) return;
              // ↓ from the filter box drops the cursor onto the matching endpoint.
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = selectedIndex < 0 ? 0 : Math.min(selectedIndex + 1, visibleRows.length - 1);
                selectRow(visibleRows[next]);
                setFocusZone("list");
                e.currentTarget.blur();
              } else if (e.key === "Enter") {
                // Enter commits the top match and jumps straight into its calls.
                e.preventDefault();
                const idx = selectedIndex < 0 ? 0 : selectedIndex;
                selectRow(visibleRows[idx]);
                setFocusZone("calls");
                e.currentTarget.blur();
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="ep-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="ep-toolbar-spacer" />

        {apps.length > 1 && (
          <select
            className="ep-env-select"
            value={selectedAppSlugs.length === apps.length ? "" : selectedAppSlugs[0] || ""}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedAppSlugs(v ? [v] : apps.map((a) => a.slug));
            }}
          >
            <option value="">All apps</option>
            {apps.map((app) => (
              <option key={app.slug} value={app.slug}>
                {app.name}
              </option>
            ))}
          </select>
        )}

        {environments.length > 0 && (
          <select
            className="ep-env-select"
            value={selectedEnv}
            onChange={(e) => setSelectedEnv(e.target.value)}
          >
            <option value="">All envs</option>
            {environments.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        )}

        <div className="ep-timerange">
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={value}
              type="button"
              className={`ep-time-btn${selectedRange === value ? " active" : ""}`}
              onClick={() => setSelectedRange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Summary stats bar ── */}
      {!loading && summaryStats.endpointCount > 0 && (
        <div className="ep-stats-bar">
          {/* Left group: volume */}
          <span className="ep-stat">
            <span className="ep-stat-n">{summaryStats.endpointCount}</span>
            <span className="ep-stat-l">endpoints</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{summaryStats.activeCount}</span>
            <span className="ep-stat-l">active</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{summaryStats.totalReqs.toLocaleString()}</span>
            <span className="ep-stat-l">requests</span>
          </span>

          <span className="ep-stat-divider" />

          {/* Right group: health */}
          <span className={`ep-stat${summaryStats.errRate >= 5 ? " tone-bad" : summaryStats.errRate >= 1 ? " tone-warn" : ""}`}>
            <span className="ep-stat-n">{summaryStats.totalErrors.toLocaleString()}</span>
            <span className="ep-stat-l">errors</span>
          </span>
          <span className={`ep-stat${summaryStats.errRate >= 5 ? " tone-bad" : summaryStats.errRate >= 1 ? " tone-warn" : ""}`}>
            <span className="ep-stat-n">{summaryStats.errRate.toFixed(2)}%</span>
            <span className="ep-stat-l">error rate</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{summaryStats.successRate.toFixed(1)}%</span>
            <span className="ep-stat-l">success</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{fmtMsShort(summaryStats.weightedAvgMs)}</span>
            <span className="ep-stat-l">avg</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{fmtMsShort(summaryStats.p95)}</span>
            <span className="ep-stat-l">p95</span>
          </span>
          <span className="ep-stat">
            <span className="ep-stat-n">{fmtBytes(summaryStats.totalData)}</span>
            <span className="ep-stat-l">data</span>
          </span>
        </div>
      )}

      {/* ── Table view: compare all endpoints at a glance ── */}
      {viewMode === "overview" ? (
        <div className="ep-table-wrap">
          {loading ? (
            <div className="ep-list-message">Loading…</div>
          ) : sortedStats.length === 0 ? (
            <div className="ep-list-message">
              {stats.length === 0 ? "No endpoint activity yet." : "No endpoints match this filter."}
            </div>
          ) : (
            <table className="ep-table">
              <thead>
                <tr>
                  {sortableTh("method", "Method", "left")}
                  {sortableTh("path", "Endpoint", "left")}
                  {grouped && <th className="ep-th ep-th-left">App</th>}
                  {sortableTh("total_requests", "Requests")}
                  {sortableTh("error_rate", "Errors")}
                  {sortableTh("avg_response_time_ms", "Avg")}
                  {sortableTh("p95_response_time_ms", "p95")}
                  {sortableTh("data", "Data")}
                  {sortableTh("last_seen_at", "Last seen")}
                </tr>
              </thead>
              <tbody>
                {sortedStats.map((row) => (
                  <tr
                    key={`${row.appSlug ?? ""}-${row.method}-${row.path}`}
                    className="ep-trow"
                    tabIndex={0}
                    role="button"
                    onClick={() => openInInspect(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openInInspect(row);
                      }
                    }}
                  >
                    <td><span className={`ep-method ${methodColor(row.method)}`}>{row.method}</span></td>
                    <td className="ep-td-path">{row.path}</td>
                    {grouped && <td className="ep-td-app">{appName(row.appSlug)}</td>}
                    <td className="ep-td-num">
                      <span className="ep-td-bar-wrap">
                        <span className="ep-td-bar" style={{ width: `${(row.total_requests / maxRequests) * 100}%` }} />
                        <span className="ep-td-barval">{row.total_requests.toLocaleString()}</span>
                      </span>
                    </td>
                    <td className={`ep-td-num ${healthClass(row.error_rate || 0)}`}>{(row.error_rate || 0).toFixed(2)}%</td>
                    <td className="ep-td-num">{fmtMsShort(row.avg_response_time_ms)}</td>
                    <td className="ep-td-num">{fmtMsShort(row.p95_response_time_ms)}</td>
                    <td className="ep-td-num">{fmtBytes(dataBytes(row))}</td>
                    <td className="ep-td-num ep-td-muted">{timeAgo(row.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
      /* ── Inspect view: two-pane drill-in ── */
      <div className="ep-body">
        <aside className={`ep-list${selectedEndpoint && isMobile ? " mobile-hidden" : ""}`}>
          <div className="ep-list-header">
            <span className="ep-list-label">ENDPOINTS</span>
            {!loading && stats.length > 0 && (
              <span className="ep-list-count">{filteredStats.length}</span>
            )}
          </div>

          <div className="ep-list-body" ref={listBodyRef}>
            {loading ? (
              <div className="ep-list-message">Loading…</div>
            ) : filteredStats.length === 0 ? (
              <div className="ep-list-message">
                {stats.length === 0 ? "No endpoint activity yet." : "No endpoints match this filter."}
              </div>
            ) : groups ? (
              groups.map(({ app, rows }) => {
                const isCollapsed = collapsedApps.has(app.slug);
                return (
                  <div className="ep-group" key={app.slug}>
                    <button
                      type="button"
                      className={`ep-group-header${isCollapsed ? " collapsed" : ""}`}
                      onClick={() => toggleApp(app.slug)}
                      aria-expanded={!isCollapsed}
                    >
                      <ChevronDown size={12} className="ep-group-chevron" />
                      <span className="ep-group-name">{app.name}</span>
                      <span className="ep-group-count">{rows.length}</span>
                    </button>
                    {!isCollapsed && rows.map((row) => renderRow(row, true))}
                  </div>
                );
              })
            ) : (
              filteredStats.map((row) => renderRow(row, false))
            )}
          </div>
        </aside>

        <main className="ep-detail">
          {selectedEndpoint ? (
            <EndpointDetailPane
              key={`${selectedEndpoint.appSlug ?? ""}-${selectedEndpoint.method}-${selectedEndpoint.path}-${since}`}
              projectSlug={projectSlug}
              method={selectedEndpoint.method}
              path={selectedEndpoint.path}
              since={since}
              environment={selectedEnv}
              appSlugs={selectedEndpoint.appSlug ? [selectedEndpoint.appSlug] : selectedAppSlugs}
              onBack={isMobile ? () => setSelectedEndpoint(null) : undefined}
              focusZone={focusZone}
              onFocusZoneChange={setFocusZone}
            />
          ) : null}
        </main>
      </div>
      )}

      {/* ── Status bar ── */}
      <div className="ep-statusbar">
        <span>
          {filteredStats.length} endpoint{filteredStats.length !== 1 ? "s" : ""}
        </span>
        <span className="ep-statusbar-dot">·</span>
        <span>{fmtCount(totalRequests)} requests</span>
        <span className="ep-statusbar-dot">·</span>
        <span>Last {rangeLabel(selectedRange)}</span>
      </div>
    </div>
  );
}
