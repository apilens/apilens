"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Search, SlidersHorizontal, X } from "lucide-react";
import type { Environment, EndpointOption, EndpointStats, EndpointStatsListResponse } from "@/types/app";

interface EndpointsContentProps {
  appSlug: string;
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
const CACHE_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 200;

type SortKey =
  | "endpoint"
  | "total_requests"
  | "error_rate"
  | "avg_response_time_ms"
  | "p95_response_time_ms"
  | "data_transfer"
  | "last_seen_at";
type SortDir = "asc" | "desc";

type CacheEntry<T> = {
  data: T;
  createdAt: number;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatLocalInput(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function buildCacheKey(payload: object): string {
  return JSON.stringify(payload);
}

function setBoundedCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { data: value, createdAt: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export default function EndpointsContent({ appSlug }: EndpointsContentProps) {
  const router = useRouter();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [observedEnvironments, setObservedEnvironments] = useState<Array<{ environment: string; total_requests: number }>>([]);
  const [stats, setStats] = useState<EndpointStats[]>([]);
  const [endpointOptions, setEndpointOptions] = useState<EndpointOption[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [selectedRange, setSelectedRange] = useState(24);

  const [customPanelOpen, setCustomPanelOpen] = useState(false);
  const [customActive, setCustomActive] = useState(false);
  const [customSinceDraft, setCustomSinceDraft] = useState("");
  const [customUntilDraft, setCustomUntilDraft] = useState("");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [customRangeError, setCustomRangeError] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [endpointFilters, setEndpointFilters] = useState<string[]>([]);
  const [endpointDropdownSearch, setEndpointDropdownSearch] = useState("");
  const [debouncedEndpointDropdownSearch, setDebouncedEndpointDropdownSearch] = useState("");
  const [statusClassFilters, setStatusClassFilters] = useState<Array<(typeof STATUS_CLASS_OPTIONS)[number]>>([]);
  const [statusCodeFilters, setStatusCodeFilters] = useState<number[]>([]);
  const [statusCodeDraft, setStatusCodeDraft] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_requests");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const customPopoverRef = useRef<HTMLDivElement | null>(null);

  const statsCacheRef = useRef<Map<string, CacheEntry<EndpointStatsListResponse>>>(new Map());
  const endpointOptionsCacheRef = useRef<Map<string, CacheEntry<EndpointOption[]>>>(new Map());

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), 250);
    return () => window.clearTimeout(t);
  }, [searchTerm]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedEndpointDropdownSearch(endpointDropdownSearch.trim()), 200);
    return () => window.clearTimeout(t);
  }, [endpointDropdownSearch]);

  useEffect(() => {
    if (!filtersOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen]);

  useEffect(() => {
    if (!customPanelOpen) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (customPopoverRef.current && !customPopoverRef.current.contains(event.target as Node)) {
        setCustomPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [customPanelOpen]);

  useEffect(() => {
    const now = new Date();
    const before = new Date(now.getTime() - selectedRange * 60 * 60 * 1000);
    setCustomSinceDraft(formatLocalInput(before));
    setCustomUntilDraft(formatLocalInput(now));
  }, [selectedRange]);

  const timeParams = useMemo(() => {
    if (customActive && customSince && customUntil) {
      return {
        since: new Date(customSince).toISOString(),
        until: new Date(customUntil).toISOString(),
      };
    }
    return {
      since: new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString(),
      until: undefined,
    };
  }, [customActive, customSince, customUntil, selectedRange]);

  const fetchStats = useCallback(async () => {
    const queryKey = buildCacheKey({
      appSlug,
      selectedEnv,
      since: timeParams.since,
      until: timeParams.until,
      statusClassFilters: [...statusClassFilters].sort(),
      statusCodeFilters: [...statusCodeFilters].sort((a, b) => a - b),
      methodFilters: [...methodFilters].sort(),
      endpointFilters: [...endpointFilters].sort(),
      q: debouncedSearchTerm,
      sortKey,
      sortDir,
      page: currentPage,
      pageSize: DEFAULT_PAGE_SIZE,
    });

    const cached = statsCacheRef.current.get(queryKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      setStats(cached.data.items);
      setTotalCount(cached.data.total_count);
      setLoading(false);
      return;
    }

    if (cached) {
      setStats(cached.data.items);
      setTotalCount(cached.data.total_count);
    }

    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("since", timeParams.since);
      if (timeParams.until) params.set("until", timeParams.until);
      if (selectedEnv) params.set("environment", selectedEnv);
      if (statusClassFilters.length > 0) params.set("status_classes", statusClassFilters.join(","));
      if (statusCodeFilters.length > 0) params.set("status_codes", statusCodeFilters.join(","));
      if (methodFilters.length > 0) params.set("methods", methodFilters.join(","));
      if (debouncedSearchTerm) params.set("q", debouncedSearchTerm);
      if (endpointFilters.length > 0) {
        for (const endpoint of endpointFilters) params.append("endpoint", endpoint);
      }
      params.set("sort_by", sortKey);
      params.set("sort_dir", sortDir);
      params.set("page", String(currentPage));
      params.set("page_size", String(DEFAULT_PAGE_SIZE));

      const res = await fetch(`/api/apps/${appSlug}/endpoint-stats?${params.toString()}`);
      if (!res.ok) return;

      const payload = (await res.json()) as EndpointStatsListResponse;
      setStats(payload.items || []);
      setTotalCount(payload.total_count || 0);
      setBoundedCache(statsCacheRef.current, queryKey, payload);
    } finally {
      setLoading(false);
    }
  }, [
    appSlug,
    currentPage,
    debouncedSearchTerm,
    endpointFilters,
    methodFilters,
    selectedEnv,
    sortDir,
    sortKey,
    statusClassFilters,
    statusCodeFilters,
    timeParams.since,
    timeParams.until,
  ]);

  const fetchEndpointOptions = useCallback(async () => {
    const queryKey = buildCacheKey({
      appSlug,
      selectedEnv,
      since: timeParams.since,
      until: timeParams.until,
      statusClassFilters: [...statusClassFilters].sort(),
      statusCodeFilters: [...statusCodeFilters].sort((a, b) => a - b),
      methodFilters: [...methodFilters].sort(),
      q: debouncedEndpointDropdownSearch,
      limit: 500,
    });

    const cached = endpointOptionsCacheRef.current.get(queryKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      setEndpointOptions(cached.data);
      return;
    }

    if (cached) setEndpointOptions(cached.data);

    const params = new URLSearchParams();
    params.set("since", timeParams.since);
    if (timeParams.until) params.set("until", timeParams.until);
    if (selectedEnv) params.set("environment", selectedEnv);
    if (statusClassFilters.length > 0) params.set("status_classes", statusClassFilters.join(","));
    if (statusCodeFilters.length > 0) params.set("status_codes", statusCodeFilters.join(","));
    if (methodFilters.length > 0) params.set("methods", methodFilters.join(","));
    if (debouncedEndpointDropdownSearch) params.set("q", debouncedEndpointDropdownSearch);
    params.set("limit", "500");

    const res = await fetch(`/api/apps/${appSlug}/endpoint-options?${params.toString()}`);
    if (!res.ok) return;

    const payload = (await res.json()) as EndpointOption[];
    setEndpointOptions(payload);
    setBoundedCache(endpointOptionsCacheRef.current, queryKey, payload);
  }, [
    appSlug,
    debouncedEndpointDropdownSearch,
    methodFilters,
    selectedEnv,
    statusClassFilters,
    statusCodeFilters,
    timeParams.since,
    timeParams.until,
  ]);

  useEffect(() => {
    async function loadEnvs() {
      try {
        const [baseRes, observedRes] = await Promise.all([
          fetch(`/api/apps/${appSlug}/environments`),
          fetch(`/api/apps/${appSlug}/environment-options?since=${encodeURIComponent(timeParams.since)}${timeParams.until ? `&until=${encodeURIComponent(timeParams.until)}` : ""}&limit=100`),
        ]);
        if (baseRes.ok) setEnvironments(await baseRes.json());
        if (observedRes.ok) setObservedEnvironments(await observedRes.json());
      } catch {
        // ignore
      }
    }
    loadEnvs();
  }, [appSlug, timeParams.since, timeParams.until]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchEndpointOptions();
  }, [fetchEndpointOptions]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    debouncedSearchTerm,
    methodFilters,
    endpointFilters,
    statusClassFilters,
    statusCodeFilters,
    selectedEnv,
    selectedRange,
    customActive,
    customSince,
    customUntil,
  ]);

  const updateDraftPart = (kind: "since" | "until", part: "date" | "time", value: string) => {
    const nowLocal = formatLocalInput(new Date());
    const current = kind === "since" ? customSinceDraft : customUntilDraft;
    const base = current || nowLocal;
    const datePart = part === "date" ? value : base.slice(0, 10);
    const timePart = part === "time" ? value : base.slice(11, 16);
    const next = datePart ? `${datePart}T${timePart || "00:00"}` : "";
    if (kind === "since") setCustomSinceDraft(next);
    else setCustomUntilDraft(next);
  };

  const applyCustomRange = () => {
    setCustomRangeError("");
    if (!customSinceDraft || !customUntilDraft) {
      setCustomRangeError("Pick both start and end time.");
      return;
    }
    const sinceMs = new Date(customSinceDraft).getTime();
    const untilMs = new Date(customUntilDraft).getTime();
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
      setCustomRangeError("Invalid date/time.");
      return;
    }
    if (sinceMs >= untilMs) {
      setCustomRangeError("Start time must be before end time.");
      return;
    }
    setCustomSince(customSinceDraft);
    setCustomUntil(customUntilDraft);
    setCustomActive(true);
    setCustomPanelOpen(false);
  };

  const resetToPresets = () => {
    setCustomActive(false);
    setCustomPanelOpen(false);
    setCustomRangeError("");
  };

  const toggleSort = (nextKey: SortKey) => {
    setCurrentPage(1);
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDir("desc");
  };

  const toggleMethodFilter = (method: string) => {
    setMethodFilters((prev) => (
      prev.includes(method)
        ? prev.filter((m) => m !== method)
        : [...prev, method]
    ));
  };

  const toggleEndpointFilter = (endpointKey: string) => {
    setEndpointFilters((prev) => (
      prev.includes(endpointKey)
        ? prev.filter((e) => e !== endpointKey)
        : [...prev, endpointKey]
    ));
  };

  const toggleStatusClassFilter = (statusClass: (typeof STATUS_CLASS_OPTIONS)[number]) => {
    const classCodes = STATUS_CODE_BY_CLASS[statusClass];
    setStatusClassFilters((prev) => {
      const isActive = prev.includes(statusClass);
      setStatusCodeFilters((codesPrev) => {
        const next = new Set(codesPrev);
        if (isActive) {
          for (const code of classCodes) next.delete(code);
        } else {
          for (const code of classCodes) next.add(code);
        }
        return [...next].sort((a, b) => a - b);
      });
      return isActive ? prev.filter((s) => s !== statusClass) : [...prev, statusClass];
    });
  };

  const toggleStatusCodeFilter = (code: number) => {
    setStatusCodeFilters((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code];
      const sorted = next.sort((a, b) => a - b);
      setStatusClassFilters((classesPrev) => {
        const classSet = new Set(classesPrev);
        for (const cls of STATUS_CLASS_OPTIONS) {
          const allSelected = STATUS_CODE_BY_CLASS[cls].every((status) => sorted.includes(status));
          if (allSelected) classSet.add(cls);
          else classSet.delete(cls);
        }
        return [...classSet];
      });
      return sorted;
    });
  };

  const addStatusCodeFromDraft = () => {
    const next = Number(statusCodeDraft.trim());
    if (!Number.isFinite(next) || next < 100 || next > 599) return;
    toggleStatusCodeFilter(next);
    setStatusCodeDraft("");
  };

  const clearAdvancedFilters = () => {
    setMethodFilters([]);
    setEndpointFilters([]);
    setStatusClassFilters([]);
    setStatusCodeFilters([]);
    setStatusCodeDraft("");
    setEndpointDropdownSearch("");
  };

  const availableMethods = useMemo(
    () => [...new Set(endpointOptions.map((row) => row.method))].sort(),
    [endpointOptions],
  );

  const availableEndpoints = useMemo(
    () => endpointOptions
      .map((row) => ({ key: `${row.method} ${row.path}`, method: row.method, path: row.path, requests: row.total_requests }))
      .sort((a, b) => b.requests - a.requests),
    [endpointOptions],
  );

  const filteredEndpointOptions = useMemo(() => {
    const q = endpointDropdownSearch.trim().toLowerCase();
    if (!q) return availableEndpoints;
    return availableEndpoints.filter((endpoint) =>
      endpoint.method.toLowerCase().includes(q) || endpoint.path.toLowerCase().includes(q),
    );
  }, [availableEndpoints, endpointDropdownSearch]);

  const advancedFilterCount = useMemo(() => {
    let count = 0;
    if (methodFilters.length > 0) count += 1;
    if (endpointFilters.length > 0) count += 1;
    if (statusClassFilters.length > 0) count += 1;
    if (statusCodeFilters.length > 0) count += 1;
    return count;
  }, [endpointFilters.length, methodFilters.length, statusClassFilters.length, statusCodeFilters.length]);

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
    const totalTransfer = stats.reduce((acc, row) => acc + row.total_request_bytes + row.total_response_bytes, 0);
    const weightedAvgLatency = totalRequests > 0
      ? stats.reduce((acc, row) => acc + row.avg_response_time_ms * row.total_requests, 0) / totalRequests
      : 0;
    const weightedP95 = totalRequests > 0
      ? stats.reduce((acc, row) => acc + row.p95_response_time_ms * row.total_requests, 0) / totalRequests
      : 0;
    const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    const requestsPerMinute = totalRequests / activeWindowMinutes;
    return { totalRequests, totalErrors, totalTransfer, weightedAvgLatency, weightedP95, errorRate, requestsPerMinute };
  }, [activeWindowMinutes, stats]);

  const activeRangeLabel = useMemo(() => {
    if (customActive && customSince && customUntil) {
      const since = new Date(customSince);
      const until = new Date(customUntil);
      return `${since.toLocaleString()} -> ${until.toLocaleString()}`;
    }
    const selected = TIME_RANGES.find((r) => r.value === selectedRange);
    return selected ? `Last ${selected.label}` : "Last 24h";
  }, [customActive, customSince, customUntil, selectedRange]);

  const environmentOptions = useMemo(() => {
    const mapped = environments.map((env) => ({ value: env.slug, label: env.name }));
    const existingValues = new Set(mapped.map((env) => env.value));
    for (const env of observedEnvironments) {
      if (!env.environment || existingValues.has(env.environment)) continue;
      mapped.push({ value: env.environment, label: env.environment });
    }
    return mapped;
  }, [environments, observedEnvironments]);

  const sortIndicator = (key: SortKey) => {
    const active = sortKey === key;
    const symbol = active ? (sortDir === "asc" ? "↑" : "↓") : "";
    return <span className={`sort-indicator${active ? " active" : ""}`}>{symbol}</span>;
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / DEFAULT_PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = totalCount === 0 ? 0 : (safePage - 1) * DEFAULT_PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * DEFAULT_PAGE_SIZE, totalCount);

  const openEndpointDetails = (method: string, path: string) => {
    const params = new URLSearchParams();
    params.set("method", method);
    params.set("path", path);
    params.set("since", timeParams.since);
    if (timeParams.until) params.set("until", timeParams.until);
    if (selectedEnv) params.set("environment", selectedEnv);
    router.push(`/apps/${appSlug}/endpoints/details?${params.toString()}`);
  };

  return (
    <div className="endpoints-page">
      <div className="endpoints-toolbar">
        <div className="endpoints-toolbar-left">
          <select className="environment-dropdown" value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value)}>
            <option value="">All environments</option>
            {environmentOptions.map((env) => (
              <option key={env.value} value={env.value}>{env.label}</option>
            ))}
          </select>

          <div className="endpoints-search">
            <Search size={14} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search endpoint or method..."
              aria-label="Search endpoints"
            />
          </div>
        </div>

        <div className="endpoints-toolbar-right">
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
              <button type="button" className={`time-range-btn${customActive ? " active" : ""}`} onClick={() => setCustomPanelOpen((prev) => !prev)}>
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
                    <button type="button" className="custom-range-apply" onClick={applyCustomRange}>Apply range</button>
                    <button type="button" className="custom-range-reset" onClick={resetToPresets}>Clear</button>
                  </div>
                  {customRangeError && <p className="custom-range-error">{customRangeError}</p>}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`endpoints-filter-btn${filtersOpen || advancedFilterCount > 0 ? " active" : ""}`}
            onClick={() => setFiltersOpen((prev) => !prev)}
          >
            <SlidersHorizontal size={13} />
            Filters
            {advancedFilterCount > 0 && <span className="filter-count">{advancedFilterCount}</span>}
          </button>
        </div>
      </div>

      <div className="active-filters-row">
        <span className="active-filter-chip">Time: {activeRangeLabel}</span>
        {selectedEnv && <span className="active-filter-chip">Env: {environmentOptions.find((e) => e.value === selectedEnv)?.label || selectedEnv}</span>}
        {methodFilters.length > 0 && <span className="active-filter-chip">Method: {methodFilters.join(", ")}</span>}
        {endpointFilters.length > 0 && <span className="active-filter-chip">Endpoints: {endpointFilters.length} selected</span>}
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

      <div className="endpoints-summary-grid">
        <div className="summary-card"><p className="summary-label">Total requests</p><p className="summary-value">{formatNumber(summary.totalRequests)}</p></div>
        <div className="summary-card"><p className="summary-label">Requests / min</p><p className="summary-value">{summary.requestsPerMinute.toFixed(2)}</p></div>
        <div className="summary-card"><p className="summary-label">Error rate</p><p className={`summary-value ${summary.errorRate >= 5 ? "tone-bad" : summary.errorRate >= 1 ? "tone-warn" : "tone-good"}`}>{summary.errorRate.toFixed(1)}%</p></div>
        <div className="summary-card"><p className="summary-label">Transfer</p><p className="summary-value">{formatBytes(summary.totalTransfer)}</p></div>
        <div className="summary-card"><p className="summary-label">Latency</p><p className="summary-value">{summary.weightedAvgLatency.toFixed(0)} ms</p><p className="summary-sub">P95 <span className="summary-sub-value">{summary.weightedP95.toFixed(0)} ms</span></p></div>
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
              <div className="advanced-filter-group">
                <p className="advanced-filter-label">Method</p>
                <div className="advanced-methods">
                  {availableMethods.map((method) => (
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
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addStatusCodeFromDraft();
                      }
                    }}
                    placeholder="Custom code"
                  />
                  <button type="button" className="advanced-add-btn" onClick={addStatusCodeFromDraft}>
                    Add
                  </button>
                </div>
                {statusCodeFilters.length > 0 && (
                  <div className="status-code-chips">
                    {statusCodeFilters.map((code) => (
                      <button key={code} type="button" className="status-code-chip" onClick={() => toggleStatusCodeFilter(code)}>
                        {code} <span aria-hidden="true">x</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="advanced-filter-group endpoint-list-group">
                <p className="advanced-filter-label">Endpoint list</p>
                <div className="endpoint-list-panel">
                  <div className="filter-dropdown-search">
                    <input
                      type="text"
                      placeholder="Search endpoint..."
                      value={endpointDropdownSearch}
                      onChange={(e) => setEndpointDropdownSearch(e.target.value)}
                    />
                  </div>
                  <div className="endpoint-list-scroll">
                    {filteredEndpointOptions.map((endpoint) => (
                      <label
                        key={endpoint.key}
                        className={`filter-checkbox${endpointFilters.includes(endpoint.key) ? " active" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={endpointFilters.includes(endpoint.key)}
                          onChange={() => toggleEndpointFilter(endpoint.key)}
                        />
                        <span className={`method-badge method-badge-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                        <span className="endpoint-path">{endpoint.path}</span>
                      </label>
                    ))}
                    {filteredEndpointOptions.length === 0 && (
                      <p className="filter-dropdown-empty">No endpoints match this search.</p>
                    )}
                  </div>
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

      {loading ? (
        <div className="endpoints-loading">Loading endpoint data...</div>
      ) : stats.length === 0 ? (
        <div className="endpoints-empty">
          <div className="endpoints-empty-icon"><Layers size={22} /></div>
          <div className="endpoints-empty-copy">
            <h3>{searchTerm ? "No endpoints match this query" : "No endpoint activity yet"}</h3>
            <p>
              {searchTerm
                ? "Try a broader search or remove some filters."
                : "Once traffic reaches your app, endpoint analytics will appear here automatically."}
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
              <button
                type="button"
                className="endpoints-empty-btn"
                onClick={resetToPresets}
              >
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
                <th><button type="button" className={`column-sort-btn${sortKey === "endpoint" ? " active" : ""}`} onClick={() => toggleSort("endpoint")}>Endpoint {sortIndicator("endpoint")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "total_requests" ? " active" : ""}`} onClick={() => toggleSort("total_requests")}>Requests {sortIndicator("total_requests")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "error_rate" ? " active" : ""}`} onClick={() => toggleSort("error_rate")}>Error Rate {sortIndicator("error_rate")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "avg_response_time_ms" ? " active" : ""}`} onClick={() => toggleSort("avg_response_time_ms")}>Avg Response {sortIndicator("avg_response_time_ms")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "p95_response_time_ms" ? " active" : ""}`} onClick={() => toggleSort("p95_response_time_ms")}>P95 Response {sortIndicator("p95_response_time_ms")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "data_transfer" ? " active" : ""}`} onClick={() => toggleSort("data_transfer")}>Data Transfer {sortIndicator("data_transfer")}</button></th>
                <th><button type="button" className={`column-sort-btn${sortKey === "last_seen_at" ? " active" : ""}`} onClick={() => toggleSort("last_seen_at")}>Last Seen {sortIndicator("last_seen_at")}</button></th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => {
                const errorClass = row.error_rate < 1 ? "low" : row.error_rate < 5 ? "medium" : "high";
                const hasTraffic = row.total_requests > 0;
                return (
                  <tr
                    key={`${row.method}-${row.path}`}
                    className="endpoint-row-clickable"
                    onClick={() => openEndpointDetails(row.method, row.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openEndpointDetails(row.method, row.path);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open details for ${row.method} ${row.path}`}
                  >
                    <td><span className={`method-badge method-badge-${row.method.toLowerCase()}`}>{row.method}</span><span className="endpoint-path">{row.path}</span></td>
                    <td className="stat-value">{formatNumber(row.total_requests)}</td>
                    <td>{hasTraffic ? <span className={`error-rate error-rate-${errorClass}`}>{row.error_rate.toFixed(1)}%</span> : <span className="stat-dash">--</span>}</td>
                    <td className="stat-value">{hasTraffic ? `${row.avg_response_time_ms.toFixed(0)} ms` : <span className="stat-dash">--</span>}</td>
                    <td className="stat-value">{hasTraffic ? `${row.p95_response_time_ms.toFixed(0)} ms` : <span className="stat-dash">--</span>}</td>
                    <td className="stat-value">{hasTraffic ? formatBytes(row.total_request_bytes + row.total_response_bytes) : <span className="stat-dash">--</span>}</td>
                    <td className="stat-value">{hasTraffic ? relativeTime(row.last_seen_at) : <span className="stat-dash">--</span>}</td>
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
