"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Layers, Search, SlidersHorizontal, X } from "lucide-react";
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

const STATUS_CLASS_OPTIONS = ["2xx", "3xx", "4xx", "5xx"] as const;
const STATUS_CODE_BY_CLASS: Record<(typeof STATUS_CLASS_OPTIONS)[number], number[]> = {
  "2xx": [200, 201, 202, 204, 206],
  "3xx": [301, 302, 304, 307, 308],
  "4xx": [400, 401, 403, 404, 409, 422, 429],
  "5xx": [500, 502, 503, 504],
};
const DEFAULT_PAGE_SIZE = 200; // Load all in the list pane (scrollable, no pagination)
const AVAILABLE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type SortKey = "endpoint" | "total_requests" | "error_rate" | "avg_response_time_ms" | "p95_response_time_ms";
type SortDir = "asc" | "desc";

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

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatMs(n: number): string {
  if (!n) return "0 ms";
  return `${Math.round(n)} ms`;
}

function formatLocalDate(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export default function ProjectEndpointsContent({ projectSlug }: ProjectEndpointsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [apps, setApps] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [stats, setStats] = useState<EndpointStat[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Time range
  const [selectedRange, setSelectedRange] = useState(24);
  const [customPanelOpen, setCustomPanelOpen] = useState(false);
  const [customActive, setCustomActive] = useState(false);
  const [customSinceDraft, setCustomSinceDraft] = useState("");
  const [customUntilDraft, setCustomUntilDraft] = useState("");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [customRangeError, setCustomRangeError] = useState("");

  // Global search + advanced filters (for the API call)
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [statusClassFilters, setStatusClassFilters] = useState<(typeof STATUS_CLASS_OPTIONS)[number][]>([]);
  const [statusCodeFilters, setStatusCodeFilters] = useState<number[]>([]);
  const [statusCodeDraft, setStatusCodeDraft] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_requests");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Left-pane list search (client-side filter on already-loaded stats)
  const [listSearch, setListSearch] = useState("");

  // Selected endpoint (drives right detail pane)
  const [selectedEndpoint, setSelectedEndpoint] = useState<SelectedEndpoint | null>(null);

  const customPopoverRef = useRef<HTMLDivElement | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize from URL parameters
  useEffect(() => {
    if (isInitialized) return;

    const range = searchParams.get("range");
    const env = searchParams.get("env");
    const app = searchParams.get("app");
    const appsParam = searchParams.get("apps");
    const methods = searchParams.get("methods");
    const statusClasses = searchParams.get("status_classes");
    const statusCodes = searchParams.get("status_codes");
    const search = searchParams.get("q");
    const customSinceParam = searchParams.get("custom_since");
    const customUntilParam = searchParams.get("custom_until");
    const sort = searchParams.get("sort");
    const order = searchParams.get("order");
    const method = searchParams.get("method");
    const path = searchParams.get("path");

    if (range) setSelectedRange(parseInt(range, 10));
    if (env) setSelectedEnv(env);

    if (appsParam) {
      setSelectedAppSlugs(appsParam.split(",").filter(Boolean));
    } else if (app) {
      setSelectedAppSlugs([app]);
    }

    if (methods) setMethodFilters(methods.split(",").filter(Boolean));
    if (statusClasses) setStatusClassFilters(statusClasses.split(",").filter(Boolean) as any);
    if (statusCodes) setStatusCodeFilters(statusCodes.split(",").map(Number).filter(n => !isNaN(n)));
    if (search) setSearchTerm(search);

    if (customSinceParam) {
      try {
        const sinceDate = new Date(customSinceParam);
        if (!isNaN(sinceDate.getTime())) {
          setCustomSince(customSinceParam);
          setCustomSinceDraft(customSinceParam);
          if (customUntilParam) {
            const untilDate = new Date(customUntilParam);
            if (!isNaN(untilDate.getTime())) {
              setCustomUntil(customUntilParam);
              setCustomUntilDraft(customUntilParam);
            }
          }
          setCustomActive(true);
        }
      } catch {
        // Invalid date, ignore
      }
    }

    if (sort && ["endpoint", "total_requests", "error_rate", "avg_response_time_ms", "p95_response_time_ms"].includes(sort)) {
      setSortKey(sort as SortKey);
    }
    if (order && ["asc", "desc"].includes(order)) {
      setSortDir(order as SortDir);
    }

    // Restore selected endpoint from URL (e.g. direct link or back-navigation)
    if (method && path) {
      setSelectedEndpoint({ method, path });
    }

    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Update URL when state changes — keep it shallow so the list doesn't re-fetch
  useEffect(() => {
    if (!isInitialized) return;

    const params = new URLSearchParams();

    if (customActive && customSince) {
      params.set("custom_since", customSince);
      if (customUntil) params.set("custom_until", customUntil);
    } else if (selectedRange !== 24) {
      params.set("range", String(selectedRange));
    }

    if (selectedEnv) params.set("env", selectedEnv);

    if (selectedAppSlugs.length > 0 && selectedAppSlugs.length < apps.length) {
      params.set("apps", selectedAppSlugs.join(","));
    }

    if (methodFilters.length > 0) params.set("methods", methodFilters.join(","));
    if (statusClassFilters.length > 0) params.set("status_classes", statusClassFilters.join(","));
    if (statusCodeFilters.length > 0) params.set("status_codes", statusCodeFilters.join(","));
    if (searchTerm) params.set("q", searchTerm);

    if (sortKey !== "total_requests" || sortDir !== "desc") {
      params.set("sort", sortKey);
      params.set("order", sortDir);
    }

    // Persist selected endpoint for shareability
    if (selectedEndpoint) {
      params.set("method", selectedEndpoint.method);
      params.set("path", selectedEndpoint.path);
    }

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });
  }, [
    isInitialized,
    selectedRange,
    selectedEnv,
    selectedAppSlugs,
    methodFilters,
    statusClassFilters,
    statusCodeFilters,
    searchTerm,
    customActive,
    customSince,
    customUntil,
    sortKey,
    sortDir,
    apps.length,
    selectedEndpoint,
    router,
  ]);

  // Debounce search
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), 250);
    return () => window.clearTimeout(t);
  }, [searchTerm]);

  // Close filters on Escape
  useEffect(() => {
    if (!filtersOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  // Close custom panel on outside click
  useEffect(() => {
    if (!customPanelOpen) return undefined;
    const onClick = (e: MouseEvent) => {
      if (customPopoverRef.current && !customPopoverRef.current.contains(e.target as Node)) {
        setCustomPanelOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [customPanelOpen]);

  // Fetch apps and environments
  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const list = (data.apps || []).map((a: any) => ({ id: a.id, name: a.name, slug: a.slug }));
          setApps(list);

          if (!isInitialized && selectedAppSlugs.length === 0) {
            setSelectedAppSlugs(list.map((a: { slug: string }) => a.slug));
          } else if (isInitialized && selectedAppSlugs.length > 0) {
            const validSlugs = selectedAppSlugs.filter(slug =>
              list.some((a: { slug: string }) => a.slug === slug)
            );
            if (validSlugs.length !== selectedAppSlugs.length) {
              setSelectedAppSlugs(validSlugs.length > 0 ? validSlugs : list.map((a: { slug: string }) => a.slug));
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

  const timeParams = useMemo(() => {
    if (customActive && customSince) {
      return { since: customSince, until: customUntil || undefined };
    }
    const since = new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString();
    return { since, until: undefined };
  }, [customActive, customSince, customUntil, selectedRange]);

  // Fetch endpoint list
  useEffect(() => {
    async function fetchEndpoints() {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (selectedAppSlugs.length) params.set("app_slugs", selectedAppSlugs.join(","));
        params.set("since", timeParams.since);
        if (timeParams.until) params.set("until", timeParams.until);
        if (selectedEnv) params.set("environment", selectedEnv);
        if (statusClassFilters.length) params.set("status_classes", statusClassFilters.join(","));
        if (statusCodeFilters.length) params.set("status_codes", statusCodeFilters.join(","));
        if (methodFilters.length) params.set("methods", methodFilters.join(","));
        if (debouncedSearchTerm) params.set("q", debouncedSearchTerm);
        params.set("sort_by", sortKey);
        params.set("sort_dir", sortDir);
        params.set("page", "1");
        params.set("page_size", String(DEFAULT_PAGE_SIZE));

        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoints?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        setStats(data.items || data || []);
        setTotalCount(data.total_count || data.total || (data.items || data || []).length);
      } finally {
        setLoading(false);
      }
    }
    fetchEndpoints();
  }, [projectSlug, selectedAppSlugs, timeParams, selectedEnv, statusClassFilters, statusCodeFilters, methodFilters, debouncedSearchTerm, sortKey, sortDir]);

  const updateDraftPart = useCallback(
    (field: "since" | "until", part: "date" | "time", value: string) => {
      const setter = field === "since" ? setCustomSinceDraft : setCustomUntilDraft;
      const currentDraft = field === "since" ? customSinceDraft : customUntilDraft;

      if (part === "date") {
        const timeVal = currentDraft ? currentDraft.slice(11, 16) : "00:00";
        setter(value ? `${value}T${timeVal}:00.000Z` : "");
      } else {
        const dateVal = currentDraft ? currentDraft.slice(0, 10) : formatLocalDate(new Date());
        setter(value ? `${dateVal}T${value}:00.000Z` : "");
      }
    },
    [customSinceDraft, customUntilDraft]
  );

  const toggleApp = (slug: string) => {
    setSelectedAppSlugs((prev) => {
      return prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
    });
  };

  const toggleMethodFilter = (method: string) => {
    setMethodFilters((prev) =>
      prev.includes(method) ? prev.filter((m) => m !== method) : [...prev, method]
    );
  };

  const toggleStatusClassFilter = (cls: (typeof STATUS_CLASS_OPTIONS)[number]) => {
    setStatusClassFilters((prev) =>
      prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls]
    );
  };

  const toggleStatusCodeFilter = (code: number) => {
    setStatusCodeFilters((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const addStatusCode = () => {
    const code = parseInt(statusCodeDraft, 10);
    if (code >= 100 && code <= 599 && !statusCodeFilters.includes(code)) {
      setStatusCodeFilters((prev) => [...prev, code]);
      setStatusCodeDraft("");
    }
  };

  const applyCustomRange = () => {
    if (!customSinceDraft) {
      setCustomRangeError("Start date and time required");
      return;
    }
    const sinceDate = new Date(customSinceDraft);
    const untilDate = customUntilDraft ? new Date(customUntilDraft) : null;
    if (Number.isNaN(sinceDate.getTime())) {
      setCustomRangeError("Invalid start date/time");
      return;
    }
    if (untilDate && Number.isNaN(untilDate.getTime())) {
      setCustomRangeError("Invalid end date/time");
      return;
    }
    if (untilDate && sinceDate >= untilDate) {
      setCustomRangeError("Start must be before end");
      return;
    }
    setCustomSince(sinceDate.toISOString());
    setCustomUntil(untilDate ? untilDate.toISOString() : "");
    setCustomActive(true);
    setCustomPanelOpen(false);
    setCustomRangeError("");
  };

  const resetToPresets = () => {
    setCustomActive(false);
    setCustomSince("");
    setCustomUntil("");
    setCustomSinceDraft("");
    setCustomUntilDraft("");
    setCustomRangeError("");
  };

  const clearAdvancedFilters = () => {
    setMethodFilters([]);
    setStatusClassFilters([]);
    setStatusCodeFilters([]);
  };

  const advancedFilterCount = methodFilters.length + statusClassFilters.length + statusCodeFilters.length;
  const activeRangeLabel = customActive
    ? customUntil
      ? `${new Date(customSince).toLocaleString()} - ${new Date(customUntil).toLocaleString()}`
      : `Since ${new Date(customSince).toLocaleString()}`
    : TIME_RANGES.find((r) => r.value === selectedRange)?.label || `${selectedRange}h`;

  // Client-side filter for the list pane (doesn't re-fetch)
  const filteredStats = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return stats;
    return stats.filter(
      (row) =>
        row.path.toLowerCase().includes(q) ||
        row.method.toLowerCase().includes(q)
    );
  }, [stats, listSearch]);

  const handleSelectEndpoint = (row: EndpointStat) => {
    setSelectedEndpoint({ method: row.method, path: row.path });
  };

  const handleClearEndpoint = () => {
    setSelectedEndpoint(null);
  };

  const hasActiveFilters =
    customActive ||
    selectedRange !== 24 ||
    selectedEnv ||
    selectedAppSlugs.length < apps.length ||
    methodFilters.length > 0 ||
    statusClassFilters.length > 0 ||
    statusCodeFilters.length > 0 ||
    searchTerm;

  return (
    <div className="endpoints-workspace">
      {/* ── Full-width toolbar ── */}
      <div className="endpoints-workspace-toolbar">
        <div className="endpoints-workspace-toolbar-row">
          {/* Time range */}
          <div className="time-range-selector">
            {TIME_RANGES.map(({ label, value }) => (
              <button
                key={value}
                type="button"
                className={`time-range-btn${selectedRange === value && !customActive ? " active" : ""}`}
                onClick={() => {
                  setSelectedRange(value);
                  setCustomActive(false);
                  setCustomPanelOpen(false);
                  setCustomRangeError("");
                }}
              >
                {label}
              </button>
            ))}
            <div className="custom-time-anchor" ref={customPopoverRef}>
              <button
                type="button"
                className={`time-range-btn${customActive ? " active" : ""}`}
                onClick={() => setCustomPanelOpen((prev) => !prev)}
              >
                Custom
              </button>
              {customPanelOpen && (
                <div className="custom-range-panel">
                  <div className="custom-range-header">
                    <div>
                      <p className="custom-range-title">Custom time range</p>
                      <p className="custom-range-subtitle">Pick start and end to refine endpoint traffic.</p>
                    </div>
                  </div>
                  <div className="custom-range-fields custom-range-fields-4">
                    <label className="custom-range-field">
                      <span>From date</span>
                      <input
                        type="date"
                        value={customSinceDraft ? customSinceDraft.slice(0, 10) : ""}
                        onChange={(e) => updateDraftPart("since", "date", e.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>From time</span>
                      <input
                        type="time"
                        value={customSinceDraft ? customSinceDraft.slice(11, 16) : "00:00"}
                        onChange={(e) => updateDraftPart("since", "time", e.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>To date</span>
                      <input
                        type="date"
                        value={customUntilDraft ? customUntilDraft.slice(0, 10) : ""}
                        onChange={(e) => updateDraftPart("until", "date", e.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>To time</span>
                      <input
                        type="time"
                        value={customUntilDraft ? customUntilDraft.slice(11, 16) : "00:00"}
                        onChange={(e) => updateDraftPart("until", "time", e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="custom-range-actions">
                    <button type="button" className="custom-range-apply" onClick={applyCustomRange}>
                      Apply range
                    </button>
                    <button type="button" className="custom-range-reset" onClick={resetToPresets}>
                      Clear
                    </button>
                  </div>
                  {customRangeError && <p className="custom-range-error">{customRangeError}</p>}
                </div>
              )}
            </div>
          </div>

          {/* Environment dropdown */}
          {environments.length > 0 && (
            <select
              className="environment-dropdown"
              value={selectedEnv}
              onChange={(e) => setSelectedEnv(e.target.value)}
            >
              <option value="">All environments</option>
              {environments.map((env) => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          )}

          {/* Global search */}
          <div className="endpoints-search" style={{ flex: 1, maxWidth: 260 }}>
            <Search size={14} />
            <input
              type="text"
              placeholder="Search endpoints..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                style={{ background: "none", border: 0, cursor: "pointer", color: "var(--text-secondary)", display: "flex", alignItems: "center" }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filters button */}
          <button
            type="button"
            className={`endpoints-filter-btn${advancedFilterCount > 0 ? " active" : ""}`}
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal size={13} />
            Filters
            {advancedFilterCount > 0 && <span className="filter-count">{advancedFilterCount}</span>}
          </button>
        </div>

        {/* Active filter chips row */}
        {hasActiveFilters && (
          <div className="active-filters-row" style={{ paddingBottom: 8 }}>
            {customActive ? (
              <span className="active-filter-chip active-filter-chip-removable">
                Time: {activeRangeLabel}
                <button type="button" className="active-filter-chip-remove" onClick={resetToPresets} aria-label="Clear custom time range">
                  <X size={12} />
                </button>
              </span>
            ) : selectedRange !== 24 && (
              <span className="active-filter-chip active-filter-chip-removable">
                Time: {activeRangeLabel}
                <button type="button" className="active-filter-chip-remove" onClick={() => setSelectedRange(24)} aria-label="Clear time range">
                  <X size={12} />
                </button>
              </span>
            )}

            {selectedEnv && (
              <span className="active-filter-chip active-filter-chip-removable">
                Env: {selectedEnv}
                <button type="button" className="active-filter-chip-remove" onClick={() => setSelectedEnv("")} aria-label="Clear environment filter">
                  <X size={12} />
                </button>
              </span>
            )}

            {apps.length > 0 && selectedAppSlugs.length > 0 && selectedAppSlugs.length < apps.length &&
              selectedAppSlugs.map(slug => {
                const app = apps.find(a => a.slug === slug);
                if (!app) return null;
                return (
                  <span key={slug} className="active-filter-chip active-filter-chip-removable">
                    App: {app.name}
                    <button type="button" className="active-filter-chip-remove" onClick={() => toggleApp(slug)} aria-label={`Remove ${app.name} filter`}>
                      <X size={12} />
                    </button>
                  </span>
                );
              })
            }

            {methodFilters.map(method => (
              <span key={method} className="active-filter-chip active-filter-chip-removable">
                {method}
                <button type="button" className="active-filter-chip-remove" onClick={() => toggleMethodFilter(method)} aria-label={`Remove ${method} filter`}>
                  <X size={12} />
                </button>
              </span>
            ))}

            {statusClassFilters.map(statusClass => (
              <span key={statusClass} className="active-filter-chip active-filter-chip-removable">
                {statusClass}
                <button type="button" className="active-filter-chip-remove" onClick={() => toggleStatusClassFilter(statusClass)} aria-label={`Remove ${statusClass} filter`}>
                  <X size={12} />
                </button>
              </span>
            ))}

            {statusCodeFilters.map(code => (
              <span key={code} className="active-filter-chip active-filter-chip-removable">
                {code}
                <button type="button" className="active-filter-chip-remove" onClick={() => toggleStatusCodeFilter(code)} aria-label={`Remove ${code} filter`}>
                  <X size={12} />
                </button>
              </span>
            ))}

            {searchTerm && (
              <span className="active-filter-chip active-filter-chip-removable">
                Search: &ldquo;{searchTerm}&rdquo;
                <button type="button" className="active-filter-chip-remove" onClick={() => setSearchTerm("")} aria-label="Clear search">
                  <X size={12} />
                </button>
              </span>
            )}

            <button
              type="button"
              className="active-filter-clear"
              onClick={() => {
                resetToPresets();
                setSelectedEnv("");
                if (apps.length > 0) setSelectedAppSlugs(apps.map(a => a.slug));
                clearAdvancedFilters();
                setSearchTerm("");
                setSelectedRange(24);
              }}
            >
              Clear all filters
            </button>
          </div>
        )}
      </div>

      {/* ── Two-pane body ── */}
      <div className="endpoints-workspace-body">
        {/* Left pane — hidden on mobile when an endpoint is selected */}
        <aside className={`endpoints-list-pane${selectedEndpoint ? " hidden-mobile" : ""}`}>
          <div className="endpoints-list-header">
            {/* Inline search for filtering the loaded list */}
            <div className="endpoints-list-search">
              <Search size={13} />
              <input
                type="text"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
                placeholder="Filter endpoints..."
              />
              {listSearch && (
                <button
                  type="button"
                  onClick={() => setListSearch("")}
                  style={{ background: "none", border: 0, cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center", padding: 0 }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {/* Pane type switcher */}
            <div className="endpoints-pane-switcher">
              <button className="pane-tab active" type="button">Endpoints</button>
              <button className="pane-tab disabled" type="button" title="Coming soon" disabled>
                Synthetic <span className="pane-tab-badge">Soon</span>
              </button>
            </div>
          </div>

          <div className="endpoints-list-body">
            {loading ? (
              <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
            ) : filteredStats.length === 0 ? (
              <div style={{ padding: "16px", color: "var(--text-muted)", fontSize: 13 }}>
                {stats.length === 0 ? "No endpoint activity yet." : "No endpoints match this filter."}
              </div>
            ) : (
              filteredStats.map((row) => {
                const isSelected = selectedEndpoint?.method === row.method && selectedEndpoint?.path === row.path;
                const errorRate = row.error_rate || (row.total_requests > 0 ? (row.error_count / row.total_requests) * 100 : 0);
                return (
                  <button
                    key={`${row.method}-${row.path}`}
                    type="button"
                    className={`endpoint-list-row${isSelected ? " selected" : ""}`}
                    onClick={() => handleSelectEndpoint(row)}
                  >
                    <div className="endpoint-list-row-top">
                      <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
                      <span className="endpoint-list-path">{row.path}</span>
                    </div>
                    <div className="endpoint-list-row-meta">
                      <span>{formatNumber(row.total_requests)} req</span>
                      <span className={errorRate > 5 ? "meta-err" : ""}>{errorRate.toFixed(1)}% err</span>
                      <span>{formatMs(row.p95_response_time_ms)} p95</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Right detail pane */}
        <main className="endpoints-detail-pane">
          {selectedEndpoint ? (
            <>
              {/* Mobile back button */}
              <button
                type="button"
                className="endpoint-detail-pane-back"
                onClick={handleClearEndpoint}
              >
                <ArrowLeft size={14} />
                Endpoints
              </button>
              <EndpointDetailPane
                key={`${selectedEndpoint.method}-${selectedEndpoint.path}-${timeParams.since}`}
                projectSlug={projectSlug}
                method={selectedEndpoint.method}
                path={selectedEndpoint.path}
                since={timeParams.since}
                until={timeParams.until}
                environment={selectedEnv}
                appSlugs={selectedAppSlugs}
              />
            </>
          ) : (
            <div className="endpoints-detail-empty">
              <Layers size={40} />
              <p>Select an endpoint to view details</p>
            </div>
          )}
        </main>
      </div>

      {/* ── Advanced filters drawer ── */}
      {filtersOpen && (
        <div className="filters-drawer-overlay" onClick={() => setFiltersOpen(false)}>
          <aside className="filters-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="filters-drawer-header">
              <div>
                <p className="filters-drawer-kicker">Endpoint filters</p>
                <h3>Refine dataset</h3>
              </div>
              <button type="button" className="filters-drawer-close" onClick={() => setFiltersOpen(false)} aria-label="Close filters">
                <X size={16} />
              </button>
            </div>

            <div className="filters-drawer-body">
              {apps.length > 0 && (
                <div className="advanced-filter-group">
                  <p className="advanced-filter-label">Apps ({selectedAppSlugs.length}/{apps.length} selected)</p>
                  <div className="advanced-methods">
                    {apps.map((app) => (
                      <button
                        key={app.slug}
                        type="button"
                        className={`advanced-pill${selectedAppSlugs.includes(app.slug) ? " active" : ""}`}
                        onClick={() => toggleApp(app.slug)}
                      >
                        {app.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="advanced-filter-group">
                <p className="advanced-filter-label">Method</p>
                <div className="advanced-methods">
                  {AVAILABLE_METHODS.map((method) => (
                    <button
                      key={method}
                      type="button"
                      className={`advanced-pill${methodFilters.includes(method) ? " active" : ""}`}
                      onClick={() => toggleMethodFilter(method)}
                    >
                      {method}
                    </button>
                  ))}
                </div>
              </div>

              <div className="advanced-filter-group">
                <p className="advanced-filter-label">Status class</p>
                <div className="status-matrix">
                  {STATUS_CLASS_OPTIONS.map((statusClass) => (
                    <div key={statusClass} className="status-class-block">
                      <label className={`filter-checkbox class${statusClassFilters.includes(statusClass) ? " active" : ""}`}>
                        <input
                          type="checkbox"
                          checked={statusClassFilters.includes(statusClass)}
                          onChange={() => toggleStatusClassFilter(statusClass)}
                        />
                        <strong>{statusClass}</strong>
                      </label>
                      <div className="status-class-codes">
                        {STATUS_CODE_BY_CLASS[statusClass].map((code) => (
                          <button
                            key={code}
                            type="button"
                            className={`advanced-pill${statusCodeFilters.includes(code) ? " active" : ""}`}
                            onClick={() => toggleStatusCodeFilter(code)}
                          >
                            {code}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="status-code-input-row">
                  <input
                    type="number"
                    min="100"
                    max="599"
                    value={statusCodeDraft}
                    onChange={(e) => setStatusCodeDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addStatusCode(); }}
                    placeholder="Custom code (e.g. 418)"
                    className="status-code-input"
                  />
                  <button type="button" onClick={addStatusCode} className="status-code-add">
                    Add
                  </button>
                </div>
              </div>
            </div>

            <div className="filters-drawer-actions">
              <button type="button" className="advanced-clear" onClick={clearAdvancedFilters}>
                Reset all
              </button>
              <button type="button" className="custom-range-apply" onClick={() => setFiltersOpen(false)}>
                Done
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
