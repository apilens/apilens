"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Fingerprint, RefreshCw, Search, X } from "lucide-react";
import {
  formatMs,
  formatNumber,
  timeAgo,
} from "../endpoints/detail/sections";

interface ConsumersContentProps {
  projectSlug: string;
}

type AppOption = { id: string; name: string; slug: string };

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

const TIME_RANGES = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
] as const;

export default function ConsumersContent({ projectSlug }: ConsumersContentProps) {
  const router = useRouter();

  const [apps, setApps] = useState<AppOption[]>([]);
  const [selectedAppSlugs, setSelectedAppSlugs] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [selectedRange, setSelectedRange] = useState(24);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [rows, setRows] = useState<ConsumerStat[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Debounce the search box so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const since = useMemo(
    () => new Date(Date.now() - selectedRange * 60 * 60 * 1000).toISOString(),
    [selectedRange, refreshKey],
  );

  // Apps + environments for the filter selects.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps`);
        if (res.ok) {
          const data = await res.json();
          setApps((data.apps || []).map((a: AppOption) => ({ id: a.id, name: a.name, slug: a.slug })));
        }
      } catch { /* ignore */ }
    })();
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/environments`);
        if (res.ok) {
          const data = await res.json();
          setEnvironments(data.environments || []);
        }
      } catch { /* ignore */ }
    })();
  }, [projectSlug]);

  const appScope = useCallback(
    (p: URLSearchParams) => {
      if (selectedAppSlugs.length && (apps.length === 0 || selectedAppSlugs.length < apps.length)) {
        p.set("app_slugs", selectedAppSlugs.join(","));
      }
    },
    [selectedAppSlugs, apps.length],
  );

  // Consumer stats.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const p = new URLSearchParams();
      p.set("since", since);
      if (selectedEnv) p.set("environment", selectedEnv);
      if (debouncedSearch) p.set("search", debouncedSearch);
      appScope(p);
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
  }, [projectSlug, since, selectedEnv, debouncedSearch, appScope, refreshKey]);

  const maxRequests = useMemo(
    () => Math.max(1, ...(rows || []).map((r) => r.total_requests)),
    [rows],
  );

  // Drill into a consumer's requests in Request logs, with the current
  // app/env/time filters carried across.
  const openConsumer = (c: ConsumerStat) => {
    const p = new URLSearchParams();
    // Filter by the stable identifier, not the display name.
    p.set("consumer", c.consumer_identifier || c.consumer);
    if (selectedRange !== 24) p.set("range", String(selectedRange));
    if (selectedEnv) p.set("env", selectedEnv);
    if (apps.length && selectedAppSlugs.length && selectedAppSlugs.length < apps.length) {
      p.set("apps", selectedAppSlugs.join(","));
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

        {apps.length > 1 && (
          <select
            className="ep-env-select"
            value={selectedAppSlugs.length === apps.length || selectedAppSlugs.length === 0 ? "" : selectedAppSlugs[0] || ""}
            onChange={(e) => setSelectedAppSlugs(e.target.value ? [e.target.value] : apps.map((a) => a.slug))}
          >
            <option value="">All apps</option>
            {apps.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
          </select>
        )}

        {environments.length > 0 && (
          <select className="ep-env-select" value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value)}>
            <option value="">All envs</option>
            {environments.map((env) => <option key={env} value={env}>{env}</option>)}
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

        <button type="button" className="tf-refresh" onClick={() => setRefreshKey((k) => k + 1)} title="Refresh" aria-label="Refresh">
          <RefreshCw size={14} className={loading ? "tf-spin" : ""} />
        </button>
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
