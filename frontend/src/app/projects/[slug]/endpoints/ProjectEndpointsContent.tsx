"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers, Search, SlidersHorizontal, X } from "lucide-react";

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
const DEFAULT_PAGE_SIZE = 25;
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

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatLocalDate(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function formatLocalTime(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export default function ProjectEndpointsContent({ projectSlug }: ProjectEndpointsContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [projectName, setProjectName] = useState("");
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
  const [customSinceDraft, setCustomSinceDraft] = useState(""); // ISO string for draft
  const [customUntilDraft, setCustomUntilDraft] = useState(""); // ISO string for draft
  const [customSince, setCustomSince] = useState(""); // ISO string for API
  const [customUntil, setCustomUntil] = useState(""); // ISO string for API
  const [customRangeError, setCustomRangeError] = useState("");

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [statusClassFilters, setStatusClassFilters] = useState<(typeof STATUS_CLASS_OPTIONS)[number][]>([]);
  const [statusCodeFilters, setStatusCodeFilters] = useState<number[]>([]);
  const [statusCodeDraft, setStatusCodeDraft] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_requests");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const customPopoverRef = useRef<HTMLDivElement | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Fetch project info
  useEffect(() => {
    async function fetchProject() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}`);
        if (res.ok) {
          const data = await res.json();
          setProjectName(data.name || projectSlug);
        }
      } catch {
        setProjectName(projectSlug);
      }
    }
    fetchProject();
  }, [projectSlug]);

  // Initialize from URL parameters
  useEffect(() => {
    if (isInitialized) return;

    const range = searchParams.get("range");
    const env = searchParams.get("env");
    const methods = searchParams.get("methods");
    const statusClasses = searchParams.get("status_classes");
    const statusCodes = searchParams.get("status_codes");
    const search = searchParams.get("q");
    const page = searchParams.get("page");

    if (range) setSelectedRange(parseInt(range, 10));
    if (env) setSelectedEnv(env);
    if (methods) setMethodFilters(methods.split(","));
    if (statusClasses) setStatusClassFilters(statusClasses.split(",") as any);
    if (statusCodes) setStatusCodeFilters(statusCodes.split(",").map(Number));
    if (search) setSearchTerm(search);
    if (page) setCurrentPage(parseInt(page, 10));

    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Update URL when filters change
  useEffect(() => {
    if (!isInitialized) return;

    const params = new URLSearchParams();
    if (selectedRange !== 24) params.set("range", String(selectedRange));
    if (selectedEnv) params.set("env", selectedEnv);
    if (methodFilters.length > 0) params.set("methods", methodFilters.join(","));
    if (statusClassFilters.length > 0) params.set("status_classes", statusClassFilters.join(","));
    if (statusCodeFilters.length > 0) params.set("status_codes", statusCodeFilters.join(","));
    if (searchTerm) params.set("q", searchTerm);
    if (currentPage > 1) params.set("page", String(currentPage));

    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });
  }, [isInitialized, selectedRange, selectedEnv, methodFilters, statusClassFilters, statusCodeFilters, searchTerm, currentPage, router]);

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

  // Fetch apps and environments
  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          const list = (data.apps || []).map((a: any) => ({ id: a.id, name: a.name, slug: a.slug }));
          setApps(list);
          if (!isInitialized) {
            setSelectedAppSlugs(list.map((a: { slug: string }) => a.slug));
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
  }, [projectSlug, isInitialized]);

  const timeParams = useMemo(() => {
    if (customActive && customSince) {
      return { since: customSince, until: customUntil || undefined };
    }
    const since = new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString();
    return { since, until: undefined };
  }, [customActive, customSince, customUntil, selectedRange]);

  // Fetch endpoints
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
        params.set("page", String(currentPage));
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
  }, [projectSlug, selectedAppSlugs, timeParams, selectedEnv, statusClassFilters, statusCodeFilters, methodFilters, debouncedSearchTerm, sortKey, sortDir, currentPage]);

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
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      setCurrentPage(1);
      return next;
    });
  };

  const toggleMethodFilter = (method: string) => {
    setMethodFilters((prev) => {
      const next = prev.includes(method) ? prev.filter((m) => m !== method) : [...prev, method];
      setCurrentPage(1);
      return next;
    });
  };

  const toggleStatusClassFilter = (cls: (typeof STATUS_CLASS_OPTIONS)[number]) => {
    setStatusClassFilters((prev) => {
      const next = prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls];
      setCurrentPage(1);
      return next;
    });
  };

  const toggleStatusCodeFilter = (code: number) => {
    setStatusCodeFilters((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      setCurrentPage(1);
      return next;
    });
  };

  const addStatusCode = () => {
    const code = parseInt(statusCodeDraft, 10);
    if (code >= 100 && code <= 599 && !statusCodeFilters.includes(code)) {
      setStatusCodeFilters((prev) => [...prev, code]);
      setStatusCodeDraft("");
      setCurrentPage(1);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setCurrentPage(1);
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortDir === "asc" ? " ↑" : " ↓";
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
    setCurrentPage(1);
  };

  const resetToPresets = () => {
    setCustomActive(false);
    setCustomSince("");
    setCustomUntil("");
    setCustomSinceDraft("");
    setCustomUntilDraft("");
    setCustomRangeError("");
    setCurrentPage(1);
  };

  const clearAdvancedFilters = () => {
    setMethodFilters([]);
    setStatusClassFilters([]);
    setStatusCodeFilters([]);
    setCurrentPage(1);
  };

  const advancedFilterCount = methodFilters.length + statusClassFilters.length + statusCodeFilters.length;
  const activeRangeLabel = customActive
    ? customUntil
      ? `${new Date(customSince).toLocaleString()} - ${new Date(customUntil).toLocaleString()}`
      : `Since ${new Date(customSince).toLocaleString()}`
    : TIME_RANGES.find((r) => r.value === selectedRange)?.label || `${selectedRange}h`;

  const safePage = Math.max(1, Math.min(currentPage, Math.ceil(totalCount / DEFAULT_PAGE_SIZE) || 1));
  const totalPages = Math.ceil(totalCount / DEFAULT_PAGE_SIZE) || 1;

  const activeWindowMinutes = useMemo(() => {
    if (customActive && customSince && customUntil) {
      const sinceMs = new Date(customSince).getTime();
      const untilMs = new Date(customUntil).getTime();
      if (!Number.isNaN(sinceMs) && !Number.isNaN(untilMs) && untilMs > sinceMs) {
        return Math.max(1, Math.round((untilMs - sinceMs) / (1000 * 60)));
      }
    }
    return Math.max(1, selectedRange * 60);
  }, [customActive, customSince, customUntil, selectedRange]);

  const summary = useMemo(() => {
    const totalRequests = stats.reduce((acc, row) => acc + row.total_requests, 0);
    const totalErrors = stats.reduce((acc, row) => acc + row.error_count, 0);
    const weightedAvgLatency = totalRequests > 0
      ? stats.reduce((acc, row) => acc + row.avg_response_time_ms * row.total_requests, 0) / totalRequests
      : 0;
    const weightedP95 = totalRequests > 0
      ? stats.reduce((acc, row) => acc + row.p95_response_time_ms * row.total_requests, 0) / totalRequests
      : 0;
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    const requestsPerMinute = totalRequests / activeWindowMinutes;
    return { totalRequests, totalErrors, weightedAvgLatency, weightedP95, errorRate, requestsPerMinute };
  }, [activeWindowMinutes, stats]);
  const pageStart = (safePage - 1) * DEFAULT_PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * DEFAULT_PAGE_SIZE, totalCount);

  return (
    <div className="endpoints-page">
      <div className="endpoints-toolbar">
        <div className="endpoints-toolbar-left">
          <div className="endpoints-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Search endpoints..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button type="button" onClick={() => setSearchTerm("")} style={{ background: "none", border: 0, cursor: "pointer", color: "var(--text-secondary)", display: "flex", alignItems: "center" }}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="endpoints-toolbar-right">
          {environments.length > 0 && (
            <select
              className="environment-dropdown"
              value={selectedEnv}
              onChange={(e) => {
                setSelectedEnv(e.target.value);
                setCurrentPage(1);
              }}
            >
              <option value="">All environments</option>
              {environments.map((env) => (
                <option key={env} value={env}>{env}</option>
              ))}
            </select>
          )}

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
      </div>

      <div className="active-filters-row">
        <span className="active-filter-chip">Time: {activeRangeLabel}</span>
        {selectedEnv && <span className="active-filter-chip">Env: {selectedEnv}</span>}
        {apps.length > 0 && selectedAppSlugs.length < apps.length && (
          <span className="active-filter-chip">
            Apps: {selectedAppSlugs.map(slug => apps.find(a => a.slug === slug)?.name).join(", ")}
          </span>
        )}
        {methodFilters.length > 0 && <span className="active-filter-chip">Method: {methodFilters.join(", ")}</span>}
        {statusClassFilters.length > 0 && <span className="active-filter-chip">Status: {statusClassFilters.join(", ")}</span>}
        {statusCodeFilters.length > 0 && <span className="active-filter-chip">Codes: {statusCodeFilters.join(", ")}</span>}
        {customActive && (
          <button type="button" className="active-filter-clear" onClick={resetToPresets}>
            Clear custom range
          </button>
        )}
        {advancedFilterCount > 0 && (
          <button type="button" className="active-filter-clear" onClick={clearAdvancedFilters}>
            Clear filters
          </button>
        )}
      </div>

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
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addStatusCode();
                    }}
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

      <div className="endpoints-summary-grid">
        <div className="summary-card">
          <p className="summary-label">Total requests</p>
          <p className="summary-value">{formatNumber(summary.totalRequests)}</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">Requests / min</p>
          <p className="summary-value">{summary.requestsPerMinute.toFixed(2)}</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">Error rate</p>
          <p className={`summary-value ${summary.errorRate >= 5 ? "tone-bad" : summary.errorRate >= 1 ? "tone-warn" : "tone-good"}`}>
            {summary.errorRate.toFixed(1)}%
          </p>
        </div>
        <div className="summary-card">
          <p className="summary-label">Avg latency</p>
          <p className="summary-value">{summary.weightedAvgLatency.toFixed(0)} ms</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">P95 latency</p>
          <p className="summary-value">{summary.weightedP95.toFixed(0)} ms</p>
        </div>
      </div>

      {loading ? (
        <div className="endpoints-loading">Loading endpoint data...</div>
      ) : stats.length === 0 ? (
        <div className="endpoints-empty">
          <div className="endpoints-empty-icon">
            <Layers size={22} />
          </div>
          <div className="endpoints-empty-copy">
            <h3>{searchTerm ? "No endpoints match this query" : "No endpoint activity yet"}</h3>
            <p>
              {searchTerm
                ? "Try a broader search or remove some filters."
                : "Once traffic reaches your apps, endpoint analytics will appear here automatically."}
            </p>
          </div>
          <div className="endpoints-empty-actions">
            {(advancedFilterCount > 0 || searchTerm) && (
              <button
                type="button"
                className="endpoints-empty-btn endpoints-empty-btn-primary"
                onClick={() => {
                  setSearchTerm("");
                  clearAdvancedFilters();
                }}
              >
                Clear filters
              </button>
            )}
            {customActive && (
              <button type="button" className="endpoints-empty-btn" onClick={resetToPresets}>
                Reset time range
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="endpoints-table-wrapper">
          <table className="endpoints-table">
            <thead>
              <tr>
                <th>
                  <button type="button" className={`column-sort-btn${sortKey === "endpoint" ? " active" : ""}`} onClick={() => toggleSort("endpoint")}>
                    Endpoint {sortIndicator("endpoint")}
                  </button>
                </th>
                <th>
                  <button type="button" className={`column-sort-btn${sortKey === "total_requests" ? " active" : ""}`} onClick={() => toggleSort("total_requests")}>
                    Requests {sortIndicator("total_requests")}
                  </button>
                </th>
                <th>
                  <button type="button" className={`column-sort-btn${sortKey === "error_rate" ? " active" : ""}`} onClick={() => toggleSort("error_rate")}>
                    Error Rate {sortIndicator("error_rate")}
                  </button>
                </th>
                <th>
                  <button type="button" className={`column-sort-btn${sortKey === "avg_response_time_ms" ? " active" : ""}`} onClick={() => toggleSort("avg_response_time_ms")}>
                    Avg Response {sortIndicator("avg_response_time_ms")}
                  </button>
                </th>
                <th>
                  <button type="button" className={`column-sort-btn${sortKey === "p95_response_time_ms" ? " active" : ""}`} onClick={() => toggleSort("p95_response_time_ms")}>
                    P95 Response {sortIndicator("p95_response_time_ms")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => {
                const errorRate = row.error_rate || (row.total_requests > 0 ? (row.error_count / row.total_requests) * 100 : 0);
                const errorClass = errorRate < 1 ? "low" : errorRate < 5 ? "medium" : "high";
                const hasTraffic = row.total_requests > 0;
                return (
                  <tr key={`${row.method}-${row.path}`}>
                    <td>
                      <span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span>
                      <span className="endpoint-path">{row.path}</span>
                    </td>
                    <td className="stat-value">{formatNumber(row.total_requests)}</td>
                    <td>
                      {hasTraffic ? (
                        <span className={`error-rate error-rate-${errorClass}`}>{errorRate.toFixed(1)}%</span>
                      ) : (
                        <span className="stat-dash">--</span>
                      )}
                    </td>
                    <td className="stat-value">
                      {hasTraffic ? `${row.avg_response_time_ms.toFixed(0)} ms` : <span className="stat-dash">--</span>}
                    </td>
                    <td className="stat-value">
                      {hasTraffic ? `${row.p95_response_time_ms.toFixed(0)} ms` : <span className="stat-dash">--</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && totalCount > 0 && (
        <div className="endpoints-pagination">
          <p className="endpoints-pagination-meta">
            Showing {pageStart}-{pageEnd} of {totalCount}
          </p>
          <div className="endpoints-pagination-controls">
            <button
              type="button"
              className="endpoints-page-btn"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
            >
              Previous
            </button>
            <span className="endpoints-page-indicator">
              Page {safePage} / {totalPages}
            </span>
            <button
              type="button"
              className="endpoints-page-btn"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
