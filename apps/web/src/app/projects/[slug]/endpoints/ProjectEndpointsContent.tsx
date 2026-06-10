"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers, Search, X } from "lucide-react";
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
  error_rate?: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
};

type SelectedEndpoint = { method: string; path: string };
type AppOption = { id: string; name: string; slug: string };

function methodColor(m: string): string {
  const k = m.toUpperCase();
  if (k === "GET") return "ep-method-get";
  if (k === "POST") return "ep-method-post";
  if (k === "PUT" || k === "PATCH") return "ep-method-put";
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
    if (method && path) setSelectedEndpoint({ method, path });

    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Keep the URL in sync (shallow — does not re-fetch)
  useEffect(() => {
    if (!isInitialized) return;

    const params = new URLSearchParams();
    if (selectedRange !== 24) params.set("range", String(selectedRange));
    if (selectedEnv) params.set("env", selectedEnv);
    if (selectedAppSlugs.length > 0 && selectedAppSlugs.length < apps.length) {
      params.set("apps", selectedAppSlugs.join(","));
    }
    if (search) params.set("q", search);
    if (selectedEndpoint) {
      params.set("method", selectedEndpoint.method);
      params.set("path", selectedEndpoint.path);
    }

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });
  }, [isInitialized, selectedRange, selectedEnv, selectedAppSlugs, search, selectedEndpoint, apps.length, router]);

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

  // Fetch endpoint list
  useEffect(() => {
    let cancelled = false;
    async function fetchEndpoints() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (selectedAppSlugs.length) params.set("app_slugs", selectedAppSlugs.join(","));
        params.set("since", since);
        if (selectedEnv) params.set("environment", selectedEnv);
        params.set("limit", "500");

        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoints?${params.toString()}`);
        if (cancelled) return;
        if (!res.ok) {
          setStats([]);
          return;
        }
        const data = await res.json();
        setStats(data.items || data || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchEndpoints();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, selectedAppSlugs, since, selectedEnv]);

  const filteredStats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stats;
    return stats.filter(
      (row) => row.path.toLowerCase().includes(q) || row.method.toLowerCase().includes(q)
    );
  }, [stats, search]);

  const totalRequests = useMemo(
    () => stats.reduce((acc, row) => acc + row.total_requests, 0),
    [stats]
  );

  return (
    <div className="ep-workspace">
      {/* ── Toolbar ── */}
      <div className="ep-toolbar">
        <div className="ep-search">
          <Search size={12} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter endpoints…"
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

      {/* ── Two-pane body ── */}
      <div className="ep-body">
        <aside className={`ep-list${selectedEndpoint && isMobile ? " mobile-hidden" : ""}`}>
          <div className="ep-list-switcher">
            <button type="button" className="ep-pane-tab active">
              Endpoints
            </button>
            <button type="button" className="ep-pane-tab soon" disabled>
              Synthetic <span className="ep-soon-badge">soon</span>
            </button>
          </div>

          <div className="ep-list-body">
            {loading ? (
              <div className="ep-list-message">Loading…</div>
            ) : filteredStats.length === 0 ? (
              <div className="ep-list-message">
                {stats.length === 0 ? "No endpoint activity yet." : "No endpoints match this filter."}
              </div>
            ) : (
              filteredStats.map((row) => {
                const sel =
                  selectedEndpoint?.method === row.method && selectedEndpoint?.path === row.path;
                return (
                  <button
                    key={`${row.method}-${row.path}`}
                    type="button"
                    className={`ep-row${sel ? " selected" : ""}`}
                    onClick={() => setSelectedEndpoint({ method: row.method, path: row.path })}
                  >
                    <span className={`ep-method ${methodColor(row.method)}`}>
                      {row.method.slice(0, 4)}
                    </span>
                    <span className="ep-path">{row.path}</span>
                    <span className="ep-row-count">{fmtCount(row.total_requests)}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <main className="ep-detail">
          {selectedEndpoint ? (
            <EndpointDetailPane
              key={`${selectedEndpoint.method}-${selectedEndpoint.path}-${since}`}
              projectSlug={projectSlug}
              method={selectedEndpoint.method}
              path={selectedEndpoint.path}
              since={since}
              environment={selectedEnv}
              appSlugs={selectedAppSlugs}
              onBack={isMobile ? () => setSelectedEndpoint(null) : undefined}
            />
          ) : (
            <div className="ep-detail-empty">
              <Layers size={32} strokeWidth={1.5} />
              <p>Select an endpoint to view details</p>
            </div>
          )}
        </main>
      </div>

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
