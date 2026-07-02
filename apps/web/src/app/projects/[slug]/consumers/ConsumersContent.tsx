"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Fingerprint, RefreshCw, Search, X } from "lucide-react";
import {
  formatMs,
  formatNumber,
  timeAgo,
} from "../endpoints/detail/sections";
import {
  type RangeValue,
  DEFAULT_RANGE,
  ROLLING_PRESETS,
  parseRange,
  resolveRange,
  TimeRangePicker,
} from "../_shared/timeRange";
import FilterBar from "../_shared/filters/FilterBar";
import { parseFilter, serializeFilter } from "../_shared/filters/query";

interface ConsumersContentProps {
  projectSlug: string;
}

interface ConsumerStat {
  consumer: string;
  consumer_identifier: string;
  consumer_group: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  last_seen_at: string | null;
}

export default function ConsumersContent({ projectSlug }: ConsumersContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [rangeValue, setRangeValue] = useState<RangeValue>(DEFAULT_RANGE);
  // Unified rich filter (app, env, method, status, path, latency…). The
  // per-consumer `consumer` field is excluded — this page IS the consumer list.
  const [filter, setFilter] = useState("");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [rows, setRows] = useState<ConsumerStat[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);

  // Seed range / filter / search from the URL once (shareable links).
  useEffect(() => {
    if (isInitialized) return;
    setRangeValue(parseRange({
      range: searchParams.get("range") || undefined,
      since: searchParams.get("since") || undefined,
      until: searchParams.get("until") || undefined,
    }));
    const f = searchParams.get("filter");
    if (f) setFilter(f);
    const s = searchParams.get("q");
    if (s) setSearch(s);
    setIsInitialized(true);
  }, [searchParams, isInitialized]);

  // Mirror the active view into the URL so it fully describes the page.
  useEffect(() => {
    if (!isInitialized) return;
    const p = new URLSearchParams();
    if (rangeValue.type === "custom") {
      p.set("since", rangeValue.since);
      p.set("until", rangeValue.until);
    } else {
      p.set("range", rangeValue.id);
    }
    if (filter) p.set("filter", filter);
    if (search.trim()) p.set("q", search.trim());
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, [isInitialized, rangeValue, filter, search]);

  // Debounce the search box so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Re-resolve when the range changes or on refresh, so rolling windows slide.
  const resolved = useMemo(() => resolveRange(rangeValue), [rangeValue, refreshKey]);
  const { since, until } = resolved;

  // Consumer stats.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = new URLSearchParams();
      p.set("since", since);
      p.set("until", until);
      if (filter) p.set("filter", filter);
      if (debouncedSearch) p.set("search", debouncedSearch);
      p.set("limit", "500");
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/consumer-stats?${p.toString()}`);
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, since, until, filter, debouncedSearch, refreshKey]);

  const maxRequests = useMemo(
    () => Math.max(1, ...(rows || []).map((r) => r.total_requests)),
    [rows],
  );

  // Drill into a consumer's requests in Request logs, with the current
  // app/env/time filters carried across.
  const openConsumer = (c: ConsumerStat) => {
    const p = new URLSearchParams();
    // Carry the active rich filter across, plus this consumer (stable id).
    const preds = parseFilter(filter).filter((x) => x.field !== "consumer");
    preds.push({ field: "consumer", op: "is", values: [c.consumer_identifier || c.consumer] });
    p.set("filter", serializeFilter(preds));
    // Carry the range when it maps to a Request-logs preset window.
    if (rangeValue.type === "preset") {
      const hours = ROLLING_PRESETS.find((r) => r.id === rangeValue.id)?.hours;
      if (hours && hours !== 24 && [1, 6, 168, 720].includes(hours)) p.set("range", String(hours));
    }
    router.push(`/projects/${projectSlug}/endpoints?${p.toString()}`);
  };

  return (
    <div className="ep-rl">
      {/* ── Toolbar ── */}
      <div className="ep-rl-toolbar">
        <h1 className="ep-rl-title">Consumers</h1>
        <div className="ep-rl-spacer" />

        <div className="ep-search ep-rl-search">
          <Search size={12} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search consumer…"
          />
          {search && (
            <button type="button" className="ep-search-clear" onClick={() => setSearch("")} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </div>

        <TimeRangePicker value={rangeValue} resolved={resolved} onChange={setRangeValue} />

        <button type="button" className="tf-refresh" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} className={loading ? "tf-spin" : ""} />
        </button>
      </div>

      {/* Full-width rich filter row (consumer is excluded — this IS the list). */}
      <div className="ep-rl-filterrow">
        <FilterBar projectSlug={projectSlug} value={filter} onChange={setFilter} exclude={["consumer"]} />
      </div>

      {/* ── Consumer table ── */}
      <section className="ep-rl-card">
        {loading && (rows === null || rows.length === 0) ? (
          <div className="ep-rl-message">Loading consumers…</div>
        ) : rows && rows.length === 0 ? (
          <div className="ep-rl-message">
            {debouncedSearch
              ? "No consumers match this search in the selected period."
              : "No identified consumers in the selected period. Set a consumer in your SDK middleware to see them here."}
          </div>
        ) : (
          <div className="ep-recent">
            <table className="ep-recent-table ep-consumers-table">
              <thead>
                <tr>
                  <th aria-hidden />
                  <th>Consumer</th>
                  <th>Group</th>
                  <th className="ep-th-num">Requests</th>
                  <th className="ep-th-num">Error rate</th>
                  <th className="ep-th-num">Avg response</th>
                  <th className="ep-th-num">Last seen</th>
                  <th aria-hidden />
                </tr>
              </thead>
              <tbody>
                {(rows || []).map((c) => (
                  <tr
                    key={c.consumer}
                    className="ep-recent-row"
                    onClick={() => openConsumer(c)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openConsumer(c); }
                    }}
                  >
                    <td className="ep-recent-clock"><Fingerprint size={14} /></td>
                    <td className="ep-consumer-name">
                      <div className="ep-consumer-cell">
                        <span className="ep-consumer-primary">{c.consumer}</span>
                        {c.consumer_identifier && c.consumer_identifier !== c.consumer ? (
                          <span className="ep-consumer-id">{c.consumer_identifier}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="ep-consumer-group-cell">
                      {c.consumer_group ? <span className="ep-consumer-group">{c.consumer_group}</span> : <span className="ep-consumer-muted">—</span>}
                    </td>
                    <td className="ep-td-num">
                      <span className="ep-cbar-wrap">
                        <span className="ep-cbar" style={{ width: `${(c.total_requests / maxRequests) * 100}%` }} />
                        <span className="ep-cbar-val">{formatNumber(c.total_requests)}</span>
                      </span>
                    </td>
                    <td className={`ep-td-num${(c.error_rate || 0) >= 5 ? " tone-bad" : (c.error_rate || 0) >= 1 ? " tone-warn" : ""}`}>
                      {(c.error_rate || 0).toFixed(1)} %
                    </td>
                    <td className="ep-td-num">{formatMs(c.avg_response_time_ms)}</td>
                    <td className="ep-td-num">{c.last_seen_at ? timeAgo(c.last_seen_at) : "—"}</td>
                    <td className="ep-recent-go"><ChevronRight size={15} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
