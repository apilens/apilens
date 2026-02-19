"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConsumerStats } from "@/lib/api-client";

interface ConsumersContentProps {
  appSlug: string;
}

const DEFAULT_PAGE_SIZE = 25;

const TIME_RANGES = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "--";
  const hasZone = /([zZ]|[+-]\d{2}:\d{2})$/.test(dateStr);
  const then = new Date(hasZone ? dateStr : `${dateStr}Z`).getTime();
  if (Number.isNaN(then)) return "--";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatLocalInput(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export default function ConsumersContent({ appSlug }: ConsumersContentProps) {
  const router = useRouter();
  const [selectedRange, setSelectedRange] = useState(24);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [observedEnvironments, setObservedEnvironments] = useState<
    Array<{ environment: string; total_requests: number }>
  >([]);
  const [customPanelOpen, setCustomPanelOpen] = useState(false);
  const [customActive, setCustomActive] = useState(false);
  const [customSinceDraft, setCustomSinceDraft] = useState("");
  const [customUntilDraft, setCustomUntilDraft] = useState("");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [customRangeError, setCustomRangeError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [consumers, setConsumers] = useState<ConsumerStats[]>([]);
  const [newConsumers, setNewConsumers] = useState(0);
  const [previousConsumersCount, setPreviousConsumersCount] = useState(0);
  const [sortKey, setSortKey] = useState<
    "consumer" | "identifier" | "group" | "total_requests" | "error_rate" | "avg_response_time_ms" | "last_seen_at"
  >("total_requests");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const customPopoverRef = useRef<HTMLDivElement | null>(null);

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
      until: undefined as string | undefined,
    };
  }, [customActive, customSince, customUntil, selectedRange]);

  useEffect(() => {
    async function loadEnvironmentOptions() {
      try {
        const params = new URLSearchParams();
        params.set("since", timeParams.since);
        if (timeParams.until) params.set("until", timeParams.until);
        params.set("limit", "100");
        const res = await fetch(`/api/apps/${appSlug}/environment-options?${params.toString()}`);
        if (!res.ok) {
          setObservedEnvironments([]);
          return;
        }
        const payload = (await res.json()) as Array<{ environment: string; total_requests: number }>;
        setObservedEnvironments(payload);
      } catch {
        setObservedEnvironments([]);
      }
    }
    loadEnvironmentOptions();
  }, [appSlug, timeParams.since, timeParams.until]);

  const environmentOptions = useMemo(
    () =>
      observedEnvironments
        .filter((item) => item.environment && item.environment.trim().length > 0)
        .map((item) => item.environment),
    [observedEnvironments],
  );

  const filteredConsumers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return consumers;
    return consumers.filter((row) =>
      [row.consumer, row.consumer_identifier, row.consumer_name, row.consumer_group]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(q)),
    );
  }, [consumers, searchTerm]);

  const summary = useMemo(() => {
    const totalRequests = consumers.reduce((sum, row) => sum + row.total_requests, 0);
    const totalErrors = consumers.reduce((sum, row) => sum + row.error_count, 0);
    const consumerGrowthPct =
      previousConsumersCount > 0
        ? ((consumers.length - previousConsumersCount) / previousConsumersCount) * 100
        : consumers.length > 0
          ? 100
          : 0;
    const overallErrorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    return {
      totalRequests,
      activeConsumers: consumers.length,
      newConsumers,
      consumerGrowthPct,
      overallErrorRate,
    };
  }, [consumers, newConsumers, previousConsumersCount]);

  const sortedConsumers = useMemo(() => {
    const items = [...filteredConsumers];
    items.sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      switch (sortKey) {
        case "consumer":
          av = a.consumer;
          bv = b.consumer;
          break;
        case "identifier":
          av = a.consumer_identifier || a.consumer_name || "";
          bv = b.consumer_identifier || b.consumer_name || "";
          break;
        case "group":
          av = a.consumer_group || "";
          bv = b.consumer_group || "";
          break;
        case "total_requests":
          av = a.total_requests;
          bv = b.total_requests;
          break;
        case "error_rate":
          av = a.error_rate;
          bv = b.error_rate;
          break;
        case "avg_response_time_ms":
          av = a.avg_response_time_ms;
          bv = b.avg_response_time_ms;
          break;
        case "last_seen_at":
          av = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
          bv = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
          break;
      }

      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return items;
  }, [filteredConsumers, sortDir, sortKey]);

  const totalCount = sortedConsumers.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / DEFAULT_PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = totalCount === 0 ? 0 : (safePage - 1) * DEFAULT_PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * DEFAULT_PAGE_SIZE, totalCount);
  const pagedConsumers = useMemo(
    () => sortedConsumers.slice((safePage - 1) * DEFAULT_PAGE_SIZE, safePage * DEFAULT_PAGE_SIZE),
    [safePage, sortedConsumers],
  );

  const activeRangeLabel = useMemo(() => {
    if (customActive && customSince && customUntil) {
      const since = new Date(customSince);
      const until = new Date(customUntil);
      if (!Number.isNaN(since.getTime()) && !Number.isNaN(until.getTime())) {
        return `${since.toLocaleString()} -> ${until.toLocaleString()}`;
      }
    }
    return TIME_RANGES.find((range) => range.value === selectedRange)?.label || "24h";
  }, [customActive, customSince, customUntil, selectedRange]);

  const toggleSort = (
    key: "consumer" | "identifier" | "group" | "total_requests" | "error_rate" | "avg_response_time_ms" | "last_seen_at",
  ) => {
    setCurrentPage(1);
    if (sortKey === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "consumer" || key === "identifier" || key === "group" ? "asc" : "desc");
  };

  const sortIndicator = (
    key: "consumer" | "identifier" | "group" | "total_requests" | "error_rate" | "avg_response_time_ms" | "last_seen_at",
  ) => {
    const active = sortKey === key;
    const symbol = active ? (sortDir === "asc" ? "↑" : "↓") : "";
    return <span className={`sort-indicator${active ? " active" : ""}`}>{symbol}</span>;
  };

  const fetchConsumers = useCallback(async () => {
    setLoading(true);
    try {
      const periodMs = selectedRange * 60 * 60 * 1000;
      const currentSinceMs = new Date(timeParams.since).getTime();
      const prevSince = new Date(currentSinceMs - periodMs).toISOString();

      const params = new URLSearchParams();
      params.set("since", timeParams.since);
      if (timeParams.until) params.set("until", timeParams.until);
      if (selectedEnv) params.set("environment", selectedEnv);
      params.set("limit", "500");
      const res = await fetch(`/api/apps/${appSlug}/consumers?${params.toString()}`);
      if (!res.ok) {
        setConsumers([]);
        setNewConsumers(0);
        setPreviousConsumersCount(0);
        return;
      }
      const data = (await res.json()) as ConsumerStats[];
      setConsumers(data);

      const prevParams = new URLSearchParams();
      prevParams.set("since", prevSince);
      prevParams.set("until", timeParams.since);
      if (selectedEnv) prevParams.set("environment", selectedEnv);
      prevParams.set("limit", "500");
      const prevRes = await fetch(`/api/apps/${appSlug}/consumers?${prevParams.toString()}`);
      if (!prevRes.ok) {
        setNewConsumers(data.length);
        setPreviousConsumersCount(0);
        return;
      }

      const prevData = (await prevRes.json()) as ConsumerStats[];
      setPreviousConsumersCount(prevData.length);

      const prevKeys = new Set(
        prevData.map((row) => row.consumer_identifier || row.consumer_name || row.consumer),
      );
      const currentKeys = new Set(
        data.map((row) => row.consumer_identifier || row.consumer_name || row.consumer),
      );
      let newCount = 0;
      currentKeys.forEach((key) => {
        if (!prevKeys.has(key)) newCount += 1;
      });
      setNewConsumers(newCount);
    } finally {
      setLoading(false);
    }
  }, [appSlug, selectedEnv, selectedRange, timeParams.since, timeParams.until]);

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

  useEffect(() => {
    fetchConsumers();
  }, [fetchConsumers]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, selectedEnv, selectedRange, customActive, customSince, customUntil]);

  return (
    <div className="page-content endpoints-page consumers-page">
      <div className="endpoints-toolbar">
        <div className="endpoints-toolbar-left">
          <div className="endpoints-search">
            <input
              placeholder="Search consumer"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        <div className="endpoints-toolbar-right">
          <select className="environment-dropdown" value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value)}>
            <option value="">All environments</option>
            {environmentOptions.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
          <div className="time-range tabs-inline">
            {TIME_RANGES.map((range) => (
              <button
                key={range.value}
                type="button"
                className={`time-range-btn${selectedRange === range.value && !customActive ? " active" : ""}`}
                onClick={() => {
                  setSelectedRange(range.value);
                  resetToPresets();
                }}
              >
                {range.label}
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
                      <p className="custom-range-subtitle">Pick start and end for consumer traffic.</p>
                    </div>
                  </div>
                  <div className="custom-range-fields custom-range-fields-4">
                    <label className="custom-range-field">
                      <span>From date</span>
                      <input
                        type="date"
                        value={customSinceDraft ? customSinceDraft.slice(0, 10) : ""}
                        onChange={(event) => updateDraftPart("since", "date", event.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>From time</span>
                      <input
                        type="time"
                        value={customSinceDraft ? customSinceDraft.slice(11, 16) : "00:00"}
                        onChange={(event) => updateDraftPart("since", "time", event.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>To date</span>
                      <input
                        type="date"
                        value={customUntilDraft ? customUntilDraft.slice(0, 10) : ""}
                        onChange={(event) => updateDraftPart("until", "date", event.target.value)}
                      />
                    </label>
                    <label className="custom-range-field">
                      <span>To time</span>
                      <input
                        type="time"
                        value={customUntilDraft ? customUntilDraft.slice(11, 16) : "00:00"}
                        onChange={(event) => updateDraftPart("until", "time", event.target.value)}
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
        </div>
      </div>

      <div className="active-filters-row">
        <span className="active-filter-chip">Time: {activeRangeLabel}</span>
        {selectedEnv && <span className="active-filter-chip">Env: {selectedEnv}</span>}
        {searchTerm.trim() && <span className="active-filter-chip">Search: {searchTerm.trim()}</span>}
        {customActive && (
          <button type="button" className="active-filter-clear" onClick={resetToPresets}>
            Clear custom range
          </button>
        )}
      </div>

      <section className="endpoints-summary-grid">
        <article className="summary-card">
          <p className="summary-label">Active consumers</p>
          <p className="summary-value">{formatNumber(summary.activeConsumers)}</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">New consumers</p>
          <p className="summary-value">{formatNumber(summary.newConsumers)}</p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Consumer growth</p>
          <p className="summary-value">
            {summary.consumerGrowthPct >= 0 ? "+" : ""}
            {summary.consumerGrowthPct.toFixed(1)}%
          </p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Overall error rate</p>
          <p
            className={`summary-value ${
              summary.overallErrorRate >= 5
                ? "tone-bad"
                : summary.overallErrorRate >= 1
                  ? "tone-warn"
                  : "tone-good"
            }`}
          >
            {summary.overallErrorRate.toFixed(1)}%
          </p>
        </article>
        <article className="summary-card">
          <p className="summary-label">Total requests</p>
          <p className="summary-value">{formatNumber(summary.totalRequests)}</p>
        </article>
      </section>

      <div className="endpoints-table-wrap">
        {loading ? (
          <div className="endpoints-loading">Loading consumers...</div>
        ) : sortedConsumers.length === 0 ? (
          <div className="endpoints-empty">
            <div className="endpoints-empty-copy">
              <h3>No consumers found</h3>
              <p>We could not find consumer traffic in this time range.</p>
            </div>
          </div>
        ) : (
          <div className="endpoints-table-wrapper">
            <table className="endpoints-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "consumer" ? " active" : ""}`} onClick={() => toggleSort("consumer")}>
                      Consumer {sortIndicator("consumer")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "identifier" ? " active" : ""}`} onClick={() => toggleSort("identifier")}>
                      Identifier {sortIndicator("identifier")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "group" ? " active" : ""}`} onClick={() => toggleSort("group")}>
                      Group {sortIndicator("group")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "total_requests" ? " active" : ""}`} onClick={() => toggleSort("total_requests")}>
                      Requests {sortIndicator("total_requests")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "error_rate" ? " active" : ""}`} onClick={() => toggleSort("error_rate")}>
                      Error rate {sortIndicator("error_rate")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "avg_response_time_ms" ? " active" : ""}`} onClick={() => toggleSort("avg_response_time_ms")}>
                      Avg latency {sortIndicator("avg_response_time_ms")}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={`column-sort-btn${sortKey === "last_seen_at" ? " active" : ""}`} onClick={() => toggleSort("last_seen_at")}>
                      Last seen {sortIndicator("last_seen_at")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedConsumers.map((row) => (
                  <tr
                    key={`${row.consumer}-${row.consumer_identifier || "none"}-${row.consumer_group || "none"}`}
                    className="endpoint-row-clickable"
                    onClick={() =>
                      router.push(
                        `/apps/${appSlug}/consumers/${encodeURIComponent(row.consumer)}?since=${encodeURIComponent(timeParams.since)}`,
                      )
                    }
                    tabIndex={0}
                    role="button"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        router.push(
                          `/apps/${appSlug}/consumers/${encodeURIComponent(row.consumer)}?since=${encodeURIComponent(timeParams.since)}`,
                        );
                      }
                    }}
                  >
                    <td className="stat-value">{row.consumer}</td>
                    <td className="stat-value">
                      {row.consumer_identifier || row.consumer_name || "--"}
                    </td>
                    <td className="stat-value">{row.consumer_group || "--"}</td>
                    <td className="stat-value">{formatNumber(row.total_requests)}</td>
                    <td className="stat-value">{row.error_rate.toFixed(1)}%</td>
                    <td className="stat-value">{row.avg_response_time_ms.toFixed(0)} ms</td>
                    <td className="stat-value">{relativeTime(row.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
